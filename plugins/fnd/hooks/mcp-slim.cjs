#!/usr/bin/env node
// PostToolUse hook: compress large MCP tool results before they enter the model's
// context. A thin wrapper over scripts/json-slim.cjs — the shape-driven compressor
// (ADF→md, noise-drop, long-string truncate, same-shape-array crush) validated in M1.
//
// Contract (Claude Code ≥ 2.1.191, verified against live docs 2026-07-19):
//   in  — PostToolUse event JSON on stdin; the tool result is `tool_response`
//         (older builds/docs: `tool_output`). For MCP tools it is the CallToolResult:
//         a string, a `{type:'text',text}` block, an array of such blocks, or
//         `{content:[…],isError?}`. We MIRROR whatever shape arrives.
//   out — `hookSpecificOutput.updatedToolOutput` (hookEventName `PostToolUse`) REPLACES
//         the result. Print nothing → the original passes through untouched.
//
// Safety rails (any doubt → emit nothing, original survives):
//   - MCP error results (`isError:true`) and per-block error envelopes are never touched
//     — write-gating elsewhere reads them verbatim (json-slim guards the envelope too);
//   - the recovery handle is attached only to a block we actually COMPRESSED, never to a
//     verbatim-preserved error block;
//   - size gate: results ≤ 4 KB pass through;
//   - the ORIGINAL whole result is spilled to a file and referenced as `full=<path>` —
//     the recovery net for json-slim's lossy noise/truncate stages, which don't
//     self-spill (its array crush spills each array on its own). If that spill can't be
//     written, the result passes through UNCOMPRESSED (never a lossy result with no
//     recovery path);
//   - any parse/transform failure → passthrough.
//
// Spill-and-stub guard (M12b): a result the pipeline cannot shrink below FND_MCP_SLIM_STUB_BYTES —
// an incompressible passthrough, or a compressed body that is still huge — is REPLACED by a ~1 KB
// stub naming the spill path and the recovery that fits the branch it replaced (the plain CLI line,
// or `--jq <dot.path>` for a payload the compressor already declined), instead of landing in context
// raw. Same contract as the M7 CLI path-handback, moved into the hook; the stub never appears where
// a rail says passthrough (an error envelope ANYWHERE in the result — at any size, see `anyError` —
// a block carrying anything beyond `type`/`text`, platform-overflow notices, spill failure).
//
// Env: FND_MCP_SLIM (gated in plugin.json — node never spawns when 0);
//      FND_MCP_SLIM_DIR (spill directory, shared with json-slim; default os.tmpdir());
//      FND_MCP_SLIM_TTL (hours a spill survives before the exit-time sweep prunes it; default 24);
//      FND_MCP_SLIM_DEBUG (opt-in: one JSONL trace line per invocation to fnd-mcp-slim-debug.log —
//      `1` = key events, `2` = everything, sub-gate size-gate lines included);
//      FND_MCP_SLIM_STUB (0 disables the spill-and-stub guard) + FND_MCP_SLIM_STUB_BYTES (its
//      threshold; default 32768).
'use strict';

const fs = require('fs');
const path = require('path');
const { slim, sweepSpills, writeSpill, debugLog, debugEnabled, shapeHint } = require('../scripts/json-slim.cjs');

const GATE_BYTES = 4096; // only results larger than this are worth compressing

// Slim one text payload. Error envelope / non-JSON / no byte gain → original unchanged. `reason`
// (null when modified) names the passthrough branch for the debug log; `stages` = the slim stages
// that changed bytes (only populated when `trace`, i.e. FND_MCP_SLIM_DEBUG is on). `sink` collects the
// spills json-slim writes inside this call (crush markers, the jsx node-id map) so the debug line can
// name every file the invocation left on disk.
function slimText(text, trace, sink) {
  let res;
  try {
    res = slim(text, { trace, spillSink: sink });
  } catch (_) {
    return { text, modified: false, reason: 'transform-error', stages: [] };
  }
  if (res.error) return { text, modified: false, reason: 'error-shape', stages: [] }; // error shape: verbatim
  if (!res.wasModified || res.bytesOut >= res.bytesIn) {
    // `format` rides along from slim()'s non-json branch (undefined otherwise) → the debug log (M8).
    return { text, modified: false, reason: res.reason || 'no-gain', stages: res.stages || [], format: res.format };
  }
  return { text: res.output, modified: true, reason: null, stages: res.stages || [] };
}

// Slim every text block in an MCP content array, preserving non-text and verbatim blocks
// byte-for-byte. `markIndex` = the last block we actually compressed (-1 if none), so the
// recovery handle never lands on a verbatim-preserved error block. `reason` (unmodified case) is
// the first non-modifying block reason; `stages` is the union across compressed blocks. `anyError`
// is true when ANY block is an error envelope — `reason` only names the FIRST non-modifying block,
// so it cannot carry that fact (the M12b stub gate needs it for every block, at any size).
function slimBlocks(blocks, trace, sink) {
  let modified = false;
  let markIndex = -1;
  let reason = null;
  let anyError = false;
  let format; // (M8) the format tag of the first non-modifying block — meaningful only when non-json
  const stages = [];
  const out = blocks.map((b, i) => {
    if (b && typeof b === 'object' && typeof b.text === 'string') {
      const r = slimText(b.text, trace, sink);
      if (r.modified) {
        modified = true;
        markIndex = i;
        for (const s of r.stages) if (!stages.includes(s)) stages.push(s);
        return { ...b, text: r.text };
      }
      if (r.reason === 'error-shape') anyError = true;
      if (reason === null) { reason = r.reason; format = r.format; }
    }
    return b; // non-text or unchanged → untouched
  });
  return { blocks: out, modified, markIndex, anyError, reason: modified ? null : (reason || 'no-gain'), stages, format: modified ? undefined : format };
}

// Slim a tool result, mirroring its shape. Returns a descriptor for attachMarker (+ reason/stages
// for the debug log). `trace` (= debug on) gates the per-stage `stages` bookkeeping in slim().
// `anyError` rides out to the M12b stub gate on EVERY shape: `reason` names only the first
// non-modifying block, so a content array of [whale, error envelope] would otherwise look
// stubbable and swallow the envelope into the spill file.
function slimResult(result, trace, sink) {
  if (typeof result === 'string') {
    const r = slimText(result, trace, sink);
    return { value: r.text, modified: r.modified, kind: 'string', reason: r.reason, anyError: r.reason === 'error-shape', stages: r.stages, format: r.format };
  }
  if (Array.isArray(result)) {
    const r = slimBlocks(result, trace, sink);
    return { value: r.blocks, modified: r.modified, kind: 'array', markIndex: r.markIndex, reason: r.reason, anyError: r.anyError, stages: r.stages, format: r.format };
  }
  if (result && typeof result === 'object') {
    if (Array.isArray(result.content)) {
      const r = slimBlocks(result.content, trace, sink);
      return { value: { ...result, content: r.blocks }, modified: r.modified, kind: 'content', markIndex: r.markIndex, reason: r.reason, anyError: r.anyError, stages: r.stages, format: r.format };
    }
    if (typeof result.text === 'string') {
      const r = slimText(result.text, trace, sink);
      return { value: { ...result, text: r.text }, modified: r.modified, kind: 'single', reason: r.reason, anyError: r.reason === 'error-shape', stages: r.stages, format: r.format };
    }
  }
  return { value: result, modified: false, kind: 'none', reason: 'unrecognized-shape', anyError: false, stages: [] }; // unrecognized shape → no-op
}

// Append the recovery handle to the COMPRESSED text (never a verbatim/error block).
function attachMarker(res, suffix) {
  const v = res.value;
  if (res.kind === 'string') return v + suffix;
  if (res.kind === 'single') return { ...v, text: v.text + suffix };
  if (res.kind === 'array' || res.kind === 'content') {
    const blocks = res.kind === 'content' ? v.content : v;
    const i = res.markIndex;
    if (i < 0 || !blocks[i] || typeof blocks[i].text !== 'string') return null; // nowhere safe
    const clone = blocks.slice();
    clone[i] = { ...blocks[i], text: blocks[i].text + suffix };
    return res.kind === 'content' ? { ...v, content: clone } : clone;
  }
  return null;
}

// The hook's own whole-original copy; `created` gates the marker-overhead self-cleanup below.
function spillOriginal(text) {
  return writeSpill(null, 'fnd-mcp-slim-', text);
}

// The platform's own overflow path pre-empts this hook: a result over MAX_MCP_OUTPUT_TOKENS is saved
// to a `tool-results/` file and REPLACED by a short notice ("… exceeds maximum allowed tokens. Output
// has been saved to <path>"), so what reaches us is the ~1.5 KB notice — logged until now as a plain
// `size-gate` passthrough, indistinguishable from a genuinely small result. Recognize the notice and
// return the saved whale's path, so the debug log names the event `--report` pairs against a later CLI
// run (M12). Both signals are required — a payload that merely quotes the phrase is not an overflow.
// Deliberately consulted ONLY on paths that are ALREADY passing through — the size gate (a real
// notice is ~1.5 KB, always under GATE_BYTES) and the `non-json` no-gain branch (an oversized notice,
// e.g. one quoting a long payload preamble, lands there): this is a re-LABEL of a passthrough that was
// happening anyway, never a new reason to skip compression. Probing BEFORE the gate/slim would hand a
// big compressible result — one that merely contains the phrase and any tool-results path — straight
// through uncompressed AND fabricate a missed whale in `--report`.
const OVERFLOW_MSG = 'exceeds maximum allowed tokens';
const OVERFLOW_PATH = /(\/[^\s"'\\]*tool-results\/[^\s"'\\]+)/;
// In a real notice the path follows the phrase within a sentence; scanning only that window keeps the
// regex off whale-sized payloads, where its backtracking is quadratic (43 s on a 1 MB URL-dense string).
const OVERFLOW_WINDOW = 4096;
function overflowSpill(text) {
  if (typeof text !== 'string') return null;
  const at = text.indexOf(OVERFLOW_MSG);
  if (at === -1) return null;
  const m = OVERFLOW_PATH.exec(text.slice(at, at + OVERFLOW_WINDOW));
  return m ? m[1].replace(/[.,;:)\]]+$/, '') : null; // the path ends the sentence — drop its period
}

// Byte length of a result value (best-effort; a non-serializable object → 0).
function bytesOf(v) {
  try { return Buffer.byteLength(typeof v === 'string' ? v : JSON.stringify(v), 'utf8'); } catch (_) { return 0; }
}
const pctOf = (inB, outB) => (inB ? Math.round((1 - outB / inB) * 1000) / 10 : 0);

// -------------------------------------------------------------- spill-and-stub guard (M12b) --

// Default ON — only a literal `0` turns the guard off (the escape hatch: a stub is more invasive
// than compression). Any invalid FND_MCP_SLIM_STUB_BYTES falls back to the default, NEVER to 0,
// which would stub every result above the 4 KB size gate.
const STUB_BYTES_DEFAULT = 32768;
const STUB_CAP = 1200; // the stub must never become the next context problem
const STUB_TOOL_MAX = 80;
// Only these two passthrough reasons stub. `error-shape` is verbatim by contract, `platform-overflow`
// is already a tiny platform-spilled notice, and `transform-error` / `unrecognized-shape` mean we did
// not understand the payload — hand those back untouched rather than invent a shape for them.
const STUB_REASONS = new Set(['non-json', 'no-gain']);
const SLIM_CLI = path.resolve(__dirname, '..', 'scripts', 'json-slim.cjs');

function stubEnabled() {
  const raw = process.env.FND_MCP_SLIM_STUB;
  return !(raw !== undefined && String(raw).trim() === '0');
}
function stubBytes() {
  // `Number`, not `parseFloat`: parseFloat takes the numeric PREFIX, so the byte thresholds a
  // developer actually types — `32k`, `64KB`, `32 768` — would parse to 32/64 bytes and stub every
  // result above the 4 KB size gate. A whole-string parse rejects them to the default instead
  // (empty/whitespace → 0 → also the default, which is the wanted "never 0" behavior).
  // Floored at STUB_CAP so a stub can never be BIGGER than the payload it replaces: envelope
  // siblings ride along untouched, so a 300 B text next to a fat `structuredContent` would otherwise
  // be evicted AND grow the result once the threshold is set below the stub's own size.
  const n = Number(String(process.env.FND_MCP_SLIM_STUB_BYTES ?? '').trim());
  return Number.isFinite(n) && n > 0 ? Math.max(n, STUB_CAP) : STUB_BYTES_DEFAULT;
}

// The stub text. Wording mirrors hooks/mcp-whale.md so the instruction layer and the stub state one
// contract: never raw-Read a whale. The shape hint is the only DROPPABLE part — it goes whole if the cap
// is reached, leaving a few fixed lines plus the two paths (tool name capped at STUB_TOOL_MAX),
// comfortably under the cap. The command line must survive intact.
// Which recovery the stub names depends on the branch it replaced. `no-gain` over a single JSON DOCUMENT
// is the one case where a whole-file re-run is WORSE than no guard: the CLI would put the identical
// pipeline over the identical bytes and print the payload straight back (measured: a 43 KB decline
// re-dumped as 43,365 B, since the CLI's inline cap sits above the stub threshold), so that stub names the
// NARROWING command instead. Everything else keeps the plain CLI line, which is a real recovery there:
// `weak-gain` hands back the compressed body the stub replaced, and a non-JSON payload goes through the
// CLI's own shape router (JSONL profiles instead of dumping rows, logs compress, anything else hands the
// path back) — a JSONL whale is `format`-tagged broken-json/text, never `json`.
function stubText(tool, bytes, format, hint, file, reason) {
  const who = String(tool || 'MCP tool').slice(0, STUB_TOOL_MAX);
  const reRunRedumps = reason === 'no-gain' && format === 'json';
  const lines = reRunRedumps ? [
    `<<fnd-mcp-slim stub>> ${who} returned ${bytes} B (format=${format}) — too large for context, and the compressor already ran on it and gained nothing, so the FULL original was written to disk instead of being shown:`,
    `full=${file}`,
    'Do NOT re-run the compressor over the whole file (it would print the same bytes back) and never raw-Read it. Narrow instead:',
    `  node ${SLIM_CLI} ${file} --jq <dot.path>`,
    'For anything a sub-path cannot answer: grep the file, or Read it windowed (offset/limit).',
    `shape — ${hint}`,
  ] : [
    `<<fnd-mcp-slim stub>> ${who} returned ${bytes} B (format=${format}) — too large for context and not compressible here, so the FULL original was written to disk instead of being shown:`,
    `full=${file}`,
    'Compress or inspect it — never raw-Read a whale:',
    `  node ${SLIM_CLI} ${file}`,
    'That CLI handles every shape: JSON slims, JSONL profiles (never rows), logs compress, anything else hands the path back — then Read the file windowed (offset/limit) or grep it.',
    `shape — ${hint}`,
  ];
  const text = lines.join('\n');
  // Measured in BYTES, the unit the threshold and the payload gate speak.
  return Buffer.byteLength(text, 'utf8') > STUB_CAP ? lines.slice(0, -1).join('\n') : text;
}

// A block array a stub may replace: every block must be a PLAIN text block — `type:'text'` plus
// `text`, nothing else. Collapsing the array into one stub keeps only the joined text, so an
// image/screenshot block would stop rendering and any block-level field (`annotations`,
// per-block `_meta` pagination cursors) would exist neither in the stub nor in the spill, while the
// stub claims the FULL original was written to disk. A richer block → decline → raw passthrough.
// The OTHER half of the rail — no block is an error envelope — is decided by the caller from
// `slimmed.anyError`, which slimBlocks already knows for every block at any size (slimText parsed
// them all); re-probing here would both duplicate that work and force a size cutoff, above which a
// large envelope would count as "not an envelope".
const STUB_BLOCK_KEYS = new Set(['type', 'text']);
function stubbableBlocks(blocks) {
  return blocks.every((b) => b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string' &&
    Object.keys(b).every((k) => STUB_BLOCK_KEYS.has(k)));
}

// Replace the whole result with one stub text payload, mirroring the arriving shape. null = this
// shape cannot safely carry a stub (see stubbableBlocks), or we do not recognize it at all. The
// `single`/`string` shapes stay stubbable: only `.text` is replaced (and spilled whole), so every
// envelope sibling survives the spread.
function stubValue(result, text) {
  if (typeof result === 'string') return text;
  if (Array.isArray(result)) return stubbableBlocks(result) ? [{ type: 'text', text }] : null;
  if (result && typeof result === 'object') {
    if (Array.isArray(result.content)) return stubbableBlocks(result.content) ? { ...result, content: [{ type: 'text', text }] } : null;
    if (typeof result.text === 'string') return { ...result, text };
  }
  return null;
}

// What the stub's spill actually holds: the text PAYLOAD, not the MCP envelope around it. Running
// json-slim on `{"content":[{"type":"text","text":"<the whale>"}]}` would only truncate that one
// giant string — the model would follow the stub's own instruction and get nothing back. Text blocks
// are joined in order (nothing dropped); the common single-block result spills byte-identical to its
// payload. Only ever called after stubValue's shape probe, so a block array here holds plain text
// blocks only — the join is LOSSLESS, which is what lets the stub promise the full original on disk.
function payloadText(result) {
  const join = (blocks) => blocks.map((b) => b.text).join('\n\n');
  if (typeof result === 'string') return result;
  if (Array.isArray(result)) return join(result);
  if (Array.isArray(result.content)) return join(result.content);
  return result.text;
}

// The text payload a stub would replace plus its byte size, or null when this shape cannot carry a
// stub. Both stub gates measure THIS, never the serialized envelope: the bulk may live in a sibling
// field the envelope carries untouched — MCP's CallToolResult may bring `structuredContent`/`_meta`
// next to `content` — and a stub would then evict the one text the model needed, point at a
// near-empty spill, and emit MORE bytes than it replaces. Payload and size come back together so a
// whale-sized string is materialized once per result, never once per measurement.
function payloadOf(result) {
  if (stubValue(result, '') === null) return null;
  const payload = payloadText(result);
  return { payload, bytes: Buffer.byteLength(payload, 'utf8') };
}

// Build the stub + the spill it points at. Called BEFORE the compressed path writes its own
// `full=` spill, so a stubbed result is written exactly once. Returns null on any decline
// (unsupported shape, payload at/below the threshold, spill failure), leaving the caller's normal
// path untouched. Only the payload is replaced: `payload > stubLimit >= STUB_CAP` (the floor in
// stubBytes), and the stub text sits comfortably under the cap at any realistic path length
// (see stubText), so a stub comes out smaller than the payload it replaces.
function buildStub(result, tool, format, stubLimit, reason) {
  const p = payloadOf(result); // shape probe BEFORE any file is written
  if (p === null || p.bytes <= stubLimit) return null;
  const s = spillOriginal(p.payload);
  if (!s) return null; // no recovery copy → RAW passthrough (never lose the only copy)
  const h = shapeHint(p.payload);
  const fmt = format || h.format;
  return { value: stubValue(result, stubText(tool, p.bytes, fmt, h.hint, s.path, reason)), spill: s.path, format: fmt };
}

function emit(value) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: value },
    }),
  );
}

function run(raw) {
  const t0 = Date.now();
  const dbg = debugEnabled(); // cache: disabled → every trace() is a no-op and the metrics below are skipped
  const input = JSON.parse(raw);
  const tool = typeof input.tool_name === 'string' ? input.tool_name : null;
  const result = input.tool_response !== undefined ? input.tool_response : input.tool_output;

  // Every spill file this invocation writes — this hook's own whole-original/stub copy plus the crush
  // markers and jsx node-id map json-slim writes inside slim(). Read by trace() rather than passed to
  // it, so the trace call sites keep their signature and the traces that fire BEFORE slim() (error shape,
  // transform error, the size gate) report an empty list without having to say so.
  const spills = [];
  const own = (p) => { if (p) spills.push(p); return p; };

  // One debug line per invocation (opt-in). Never touches stdout; the emitting paths call it AFTER
  // writing the result. `decision` is `compressed` or `stubbed` iff we emitted updatedToolOutput.
  // `spill` stays the ONE handback path the model was given (`--report` pairs missed whales on it);
  // `spills` is the full inventory, which is what makes an orphaned crush spill visible in the log.
  const trace = (decision, reason, bytesIn, bytesOut, stages, spill, format) => {
    if (!dbg) return;
    debugLog({
      entry: 'hook', tool, decision, reason: reason || null,
      ...(format ? { format } : {}), // M8: only the non-json passthrough carries a format tag
      bytes_in: bytesIn, bytes_out: bytesOut, pct: pctOf(bytesIn, bytesOut),
      stages: stages || [], spill: spill || null, spills, ms: Date.now() - t0,
    }, undefined, input.cwd); // the event's own cwd names the project (B4.10b)
  };

  if (result === undefined || result === null) return; // nothing arrived — not a compressor invocation

  // MCP error result — never touch (the model must see failures verbatim).
  if (typeof result === 'object' && result.isError === true) {
    if (dbg) { const b = bytesOf(result); trace('passthrough', 'error-shape', b, b, [], null); }
    return;
  }

  // Size gate on the serialized result.
  let serialized;
  try {
    serialized = typeof result === 'string' ? result : JSON.stringify(result);
  } catch (_) {
    trace('passthrough', 'transform-error', 0, 0, [], null);
    return;
  }
  const bytesIn = Buffer.byteLength(serialized, 'utf8');
  if (bytesIn <= GATE_BYTES) {
    // Below the gate nothing gets compressed either way, so this is pure debug vocabulary (M12): a
    // platform overflow notice is named `platform-overflow` and carries the saved whale's path in
    // `spill`, instead of hiding among the generic `size-gate` lines.
    const overflow = dbg ? overflowSpill(serialized) : null; // probe's only consumer is the debug log
    trace('passthrough', overflow ? 'platform-overflow' : 'size-gate', bytesIn, bytesIn, [], overflow);
    return;
  }

  const stubOn = stubEnabled();
  const stubLimit = stubBytes();

  const slimmed = slimResult(result, dbg, spills); // dbg gates slim()'s per-stage `stages` bookkeeping

  // Emit the stub for `reason` if this result can carry one; false = declined, caller continues on
  // the path it was already taking. `stages` are the slim stages that ran before the stub replaced
  // the body (none on the incompressible branch). `slimmed.format` is the M8 tag of a non-json
  // passthrough (undefined once anything compressed → buildStub falls back to the shape hint's).
  const tryStub = (reason, stages) => {
    const s = buildStub(result, tool, slimmed.format, stubLimit, reason);
    if (!s) return false;
    own(s.spill);
    emit(s.value);
    if (dbg) trace('stubbed', reason, bytesIn, bytesOf(s.value), stages, s.spill, s.format);
    return true;
  };

  if (!slimmed.modified) {
    // Same re-label as the size gate, for an overflow notice that happens to exceed GATE_BYTES: the
    // branch is a passthrough either way (nothing was compressed), so naming it costs no compression
    // and keeps the event visible to `--report`'s missed-whale count. Only the `non-json` reason can
    // be an overflow notice — the platform's replacement text is prose, never a JSON result. The
    // probe also gates the stub below (an overflow notice is never stubbed), so it runs when either
    // consumer needs it — still only on a branch that is already passing through.
    // `!anyError` is the error rail for the blocks `reason` cannot speak for: it names only the FIRST
    // non-modifying block, so [whale, error envelope] would read as a plain `non-json` passthrough.
    const stubbable = stubOn && bytesIn > stubLimit && STUB_REASONS.has(slimmed.reason) && !slimmed.anyError;
    const overflow = (dbg || stubbable) && slimmed.reason === 'non-json' ? overflowSpill(serialized) : null;
    // M12b: without this, a whale the pipeline cannot shrink (non-JSON text, HTML, already-minimal
    // JSON) lands in context RAW. Hand back the stub + spill instead; the model decides what to do
    // with the file. Any decline falls through to the passthrough that was happening anyway.
    if (stubbable && !overflow && tryStub(slimmed.reason, [])) return;
    trace('passthrough', overflow ? 'platform-overflow' : (slimmed.reason || 'no-gain'), bytesIn, bytesIn, [], overflow, slimmed.format);
    return;
  }

  // M12b, second branch: 30 % off an 800 KB whale is not a win for context — a compressed body still
  // over the threshold is stubbed too. Decided BEFORE the recovery spill below, so a stubbed result
  // is written to disk exactly once (the stub's own spill, holding the payload). Measured on the
  // COMPRESSED TEXT PAYLOAD (payloadOf, no `full=` handle yet — ~90 bytes cannot decide a 32 KB
  // gate): a fat envelope sibling must not push a body that compressed to a few hundred bytes into a
  // stub, which would emit more bytes than the compressed result it replaces. The serialized envelope
  // is the cheap pre-filter — it is never smaller than the payload inside it. `!anyError` again: a
  // content array can compress one block while another is an error envelope kept verbatim — stubbing
  // there would swallow the failure the write-gating reads.
  if (stubOn && !slimmed.anyError && bytesOf(slimmed.value) > stubLimit) {
    const body = payloadOf(slimmed.value); // the COMPRESSED body, not the whale — buildStub re-reads the original
    if (body !== null && body.bytes > stubLimit && tryStub('weak-gain', slimmed.stages)) return;
  }

  // Recovery net: spill the original before handing back a lossy result. No spill → passthrough.
  const full = spillOriginal(serialized);
  if (!full) { trace('passthrough', 'spill-write-failure', bytesIn, bytesIn, [], null); return; }
  const fullPath = own(full.path);

  const value = attachMarker(slimmed, `\n\n<<full=${fullPath} original_result>>`);
  if (value === null) { trace('passthrough', 'transform-error', bytesIn, bytesIn, [], null); return; } // could not attach a handle safely → passthrough (no orphan)

  // Final net check: every gain gate upstream measures the BLOCK, before this ~130 B recovery handle and
  // the re-escaping the envelope adds around it, so a thin win (one dropped null in a big object) can
  // come out NET BIGGER than what arrived — context grown, logged as a `compressed` event with
  // bytes_out > bytes_in. The spill is unlinked because the marker naming it is being discarded (best
  // effort, and only the file this branch itself just wrote — a jsx id-map spill written inside slim()
  // is not ours to remove here and expires with the TTL sweep). `full.created` is the second half of
  // that rule: spill names are content-addressed, so this exact file may still be the target of an
  // EARLIER invocation's live `full=` handle, and deleting it would break that recovery.
  const outBytes = bytesOf(value);
  if (outBytes >= bytesIn) {
    if (full.created) {
      try { fs.unlinkSync(fullPath); } catch (_) {}
      const at = spills.indexOf(fullPath);
      if (at !== -1) spills.splice(at, 1); // the debug line must not claim a file it just removed
    }
    trace('passthrough', 'marker-overhead', bytesIn, bytesIn, slimmed.stages, null);
    return;
  }

  emit(value);
  if (dbg) trace('compressed', null, bytesIn, outBytes, slimmed.stages, fullPath);
}

// Collect the whole stdin as bytes, then decode once — decoding per Buffer chunk would
// mangle any multibyte character split across a read boundary (U+FFFD corruption on the
// large non-ASCII payloads this hook targets).
const chunks = [];
process.stdin.on('data', (d) => chunks.push(d));
process.stdin.on('end', () => {
  try {
    run(Buffer.concat(chunks).toString('utf8'));
  } catch (_) {
    // Any failure → emit nothing, original result passes through untouched.
  }
  // Spill hygiene runs AFTER the result is emitted (or passed through) so it never delays what
  // the model sees; throttled and self-guarding, so it costs one stat on the hot path.
  try { sweepSpills(); } catch (_) {}
});
