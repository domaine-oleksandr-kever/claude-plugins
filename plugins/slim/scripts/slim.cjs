#!/usr/bin/env node
// slim's Claude Code delivery: one tool result in, one JSON answer out. The compression itself is
// the engines library (engines/index.cjs, contract in engines/CONTRACT.md); this file and delivery/
// are the only code that knows Claude Code — the tool envelope per channel, host overflow files,
// SLIM_* switches, spill files and handles, the shared report log.
//
//   node slim.cjs                    one tool result; envelope on stdin:
//       {v:1, channel, tool, tool_use_id, tool_input, tool_response, is_error, cwd, session_id,
//        agentId?, pre?, bytes_in?, record?, bash_output_max_chars?}
//       channel ∈ mcp|bash|read|webfetch|websearch|grep|agent|attachment
//     (attachment: tool_response {text} = an @-mentioned file as the host framed it;
//      bash_output_max_chars: the host's bashOutputMaxChars setting, when set)
//     `record: false`: the same content was answered and logged before (an attachment asked again), so no
//     report line unless the run failed.
//     stdout, exactly one JSON object:
//       {decision:'compressed'|'stubbed', reason, result, figure, record}   replace the result
//       {decision:'passthrough', reason, record}                            keep it
//       {decision:'error', reason, record}                                  keep it; a throw was caught
//     `pre` (with `bytes_in`) is a passthrough the hooks module already decided: only its line is written.
//   node slim.cjs --distill          {v:1, text?|path?|host_path?, hint?, budgetBytes?, cwd, session_id}
//                                    → {v:1, decision, engine, reason?, text, bytesIn, bytesOut}; writes nothing
//   node slim.cjs --view             {v:1, path?|text?|host_path?, command?, jq?, engine?, out?, allowed_out?,
//                                     root, cwd, session_id} → the view tool's reply (delivery/view.cjs);
//                                    writes parts, spills and media outputs, never `out` itself
//   node slim.cjs --prompt           {v:1, text, root, cwd, session_id} → the prompt with its data spans
//                                    replaced in place (delivery/prompt.cjs); spills under <root>/.claude/slim/prompt/
//   node slim.cjs --prompt-drop      {v:1, root, files} → removes those slim-prompt files of root's prompt dir
//   node slim.cjs --access           {v:1, tool, via, spills, cwd, denied?} → one entry:"access" line per spill
//                                    file a Read, Bash or Grep call named (denied: the guard refused it),
//                                    at debug level 1 or 2
//   node slim.cjs --record           one lookup or view record on stdin → one report line, at every debug level
//   node slim.cjs --error            the hooks module's own failure → one error line
//   node slim.cjs --report [logfile] [--since ISO]
//
// Every record carries src:'slim' + its channel and goes to the report log in the spill root. Exit
// status goes through process.exitCode only, so a large stdout is never cut short.
'use strict';

const fs = require('fs');
const path = require('path');
const env = require('./delivery/env.cjs');
const spill = require('./delivery/spill.cjs');
const emit = require('./delivery/emit.cjs');
const ch = require('./delivery/channels.cjs');
const rep = require('./delivery/report.cjs');
// Loaded on first use, so a broken install still answers with an error line.
let enginesMod = null;
const engines = () => enginesMod || (enginesMod = require('./engines/index.cjs'));
const compress = (input, options) => engines().compress(input, options);
const sniff = (input) => engines().sniff(input);
const viewCore = () => require('./delivery/view.cjs');
const promptCore = () => require('./delivery/prompt.cjs');

const OUTPUT_CAP = 4_194_304 - 65_536; // the hooks module's stdout ceiling, less headroom
const PRE_REASONS = new Set(['error-shape', 'already-slim', 'size-gate', 'spill-read', 'windowed-read', 'read-guard', 'not-text']);
const STUB_REASONS = new Set(['non-json', 'no-gain', 'budget-exceeded', 'number-precision']);
const OVERFLOW_PROBE_REASONS = new Set(['non-json', 'budget-exceeded']);
const DISTILL_BUDGET = 49152;

const utf8 = (s) => Buffer.byteLength(s, 'utf8');
const { bytesOf, pctOf } = emit;

// Files this run created: the output cap and a caught throw discard the answer that named them.
let created = [];
const keep = (s) => { if (s && s.created) created.push(s.path); return s; };

// The engine options delivery always passes: names under the spill root, the remaining budget.
function engineOptions(deadline, extra) {
  const left = deadline === null ? 0 : Math.max(-1, deadline - Date.now()) || -1;
  return { spillDir: env.spillRoot(), spillNames: spill.NAMES, trace: env.debugLevel() > 0, maxMs: left, plainBytes: env.plainBytes(), ...extra };
}

// Writes the parts an emitted value cites; false when one cannot be written at its cited name.
function writeParts(parts, strings, spills) {
  for (const p of parts) {
    const cite = path.join(env.spillRoot(), p.suggestedName);
    if (!strings.some((s) => s.includes(cite))) continue;
    const w = keep(spill.writePart(p.suggestedName, p.payload));
    if (!w) return false;
    spills.push(w.path);
  }
  return true;
}

function emittedStrings(value) {
  const out = [];
  const walk = (v) => {
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') for (const k of Object.keys(v)) walk(v[k]);
  };
  walk(value);
  return out;
}

function recordOf(base, decision, reason, bytesIn, bytesOut, x = {}) {
  const seen = x.bytesSeen;
  return {
    src: 'slim', channel: base.channel, entry: 'hook', tool: base.tool, ...(base.toolUseId ? { tool_use_id: base.toolUseId } : {}),
    decision, reason: reason || null,
    ...(x.format ? { format: x.format } : {}),
    ...(x.budgetPartial ? { budget_partial: true } : {}),
    engine: x.engine || null,
    bytes_in: bytesIn, bytes_out: bytesOut, ...(Number.isFinite(seen) ? { bytes_seen: seen } : {}),
    pct: pctOf(Number.isFinite(seen) ? seen : bytesIn, bytesOut),
    stages: x.stages || [], spill: x.spill || null, spills: [...new Set(x.spills || [])], ms: Date.now() - base.t0,
    ...(x.window ? { window: x.window } : {}),
    ...(x.hint ? { hint: true } : {}),
  };
}

// MCP: the json pipeline over every text block.

// A result over MAX_MCP_OUTPUT_TOKENS reaches the hook as the host's short notice naming a
// tool-results file. Both the phrase and a path are required, and only in a small text.
const OVERFLOW_MSG = 'exceeds maximum allowed tokens';
const OVERFLOW_PATH = /(\/[^\s"'\\]*tool-results\/[^\s"'\\]+)/;
const OVERFLOW_WINDOW = 4096; // the path regex backtracks quadratically on whale-sized text
const OVERFLOW_MAX_BYTES = 8192;
function overflowSpill(text) {
  if (typeof text !== 'string' || utf8(text) > OVERFLOW_MAX_BYTES) return null;
  const at = text.indexOf(OVERFLOW_MSG);
  if (at === -1) return null;
  const m = OVERFLOW_PATH.exec(text.slice(at, at + OVERFLOW_WINDOW));
  return m ? m[1].replace(/[.,;:)\]]+$/, '') : null;
}

// The host file of a multi-block result is the content array itself, serialized; null for raw text.
function hostBlocks(text) {
  if (!text.startsWith('[')) return null;
  let v;
  try { v = JSON.parse(text); } catch (_) { return null; }
  return Array.isArray(v) && v.length && v.every((b) => b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string') ? v : null;
}

function expandedShape(original, text, blocks) {
  if (Array.isArray(original)) return blocks || [{ type: 'text', text }];
  if (original && typeof original === 'object') {
    if (Array.isArray(original.content)) return { ...original, content: blocks || [{ type: 'text', text }] };
    if (typeof original.text === 'string') return { ...original, text: blocks && blocks.length === 1 ? blocks[0].text : text };
  }
  return blocks && blocks.length === 1 ? blocks[0].text : text;
}

function mcpTexts(result) {
  const textOf = (b) => (typeof b === 'string' ? b : (b && typeof b === 'object' ? b.text : undefined));
  let list = [];
  if (typeof result === 'string') list = [result];
  else if (Array.isArray(result)) list = result.map(textOf);
  else if (result && typeof result === 'object') {
    if (Array.isArray(result.content)) list = result.content.map(textOf);
    else if (typeof result.text === 'string') list = [result.text];
  }
  return list.filter((t) => typeof t === 'string');
}

// One text through the json pipeline (the engine that handles every MCP shape: JSON, JSONL, fences,
// envelopes, Figma JSX, logs). `target` is the size above which the caller would stub the text.
function slimText(text, deadline, parts, target) {
  const r = compress({ data: text }, engineOptions(deadline, { engine: 'json', targetBytes: target || null }));
  if (r.decision !== 'compressed') return { text, modified: false, reason: r.reason || 'no-gain', stages: r.stats.stages, format: r.format };
  for (const p of r.parts || []) parts.push(p);
  return { text: r.text, modified: true, reason: null, stages: r.stats.stages, engine: r.engine };
}

// Every text block of a content array; non-text and unchanged blocks stay byte-for-byte. `markIndex` is
// the last COMPRESSED block, so the handle never lands on a verbatim error block.
function slimBlocks(blocks, deadline, parts, target) {
  let modified = false;
  let markIndex = -1;
  let reason = null;
  let anyError = false;
  let budgetBailed = 0;
  let format;
  const engines = new Set();
  const stages = [];
  // The stub limit applies to the blocks' joined text: a block may fill what the others leave, never
  // less than an even share.
  const sizes = blocks.map((b) => (b && typeof b === 'object' && typeof b.text === 'string' ? utf8(b.text) : -1));
  const texts = sizes.filter((n) => n >= 0);
  const total = texts.reduce((a, n) => a + n, 0);
  const even = target ? Math.floor(target / Math.max(1, texts.length)) : 0;
  const out = blocks.map((b, i) => {
    if (sizes[i] >= 0) {
      const r = slimText(b.text, deadline, parts, target ? Math.max(even, target - (total - sizes[i])) : null);
      if (r.modified) {
        modified = true;
        markIndex = i;
        engines.add(r.engine);
        for (const s of r.stages) if (!stages.includes(s)) stages.push(s);
        return { ...b, text: r.text };
      }
      if (r.reason === 'error-shape') anyError = true;
      if (r.reason === 'budget-exceeded') budgetBailed++;
      if (reason === null) { reason = r.reason; format = r.format; }
    }
    return b;
  });
  return { blocks: out, modified, markIndex, anyError, budgetBailed, reason: modified ? null : (reason || 'no-gain'), stages, format: modified ? undefined : format, engines };
}

function slimResult(result, deadline, parts, target) {
  const one = (r, kind, value) => ({ value, modified: r.modified, kind, reason: r.reason, anyError: r.reason === 'error-shape', stages: r.stages, format: r.format, engines: new Set(r.engine ? [r.engine] : []) });
  if (typeof result === 'string') { const r = slimText(result, deadline, parts, target); return one(r, 'string', r.text); }
  if (Array.isArray(result)) { const r = slimBlocks(result, deadline, parts, target); return { ...r, value: r.blocks, kind: 'array' }; }
  if (result && typeof result === 'object') {
    if (Array.isArray(result.content)) { const r = slimBlocks(result.content, deadline, parts, target); return { ...r, value: { ...result, content: r.blocks }, kind: 'content' }; }
    if (typeof result.text === 'string') { const r = slimText(result.text, deadline, parts, target); return one(r, 'single', { ...result, text: r.text }); }
  }
  return { value: result, modified: false, kind: 'none', reason: 'unrecognized-shape', anyError: false, stages: [], engines: new Set() };
}

const engineOf = (s) => (s.engines.has('log') ? 'log' : s.engines.has('figma') ? 'figma' : s.engines.has('jsonl') ? 'jsonl' : 'json');

function attachMarker(res, suffix) {
  const v = res.value;
  if (res.kind === 'string') return v + suffix;
  if (res.kind === 'single') return { ...v, text: v.text + suffix };
  if (res.kind === 'array' || res.kind === 'content') {
    const blocks = res.kind === 'content' ? v.content : v;
    const i = res.markIndex;
    if (i < 0 || !blocks[i] || typeof blocks[i].text !== 'string') return null;
    const clone = blocks.slice();
    clone[i] = { ...blocks[i], text: blocks[i].text + suffix };
    return res.kind === 'content' ? { ...v, content: clone } : clone;
  }
  return null;
}

const STUB_BLOCK_KEYS = new Set(['type', 'text']);
const stubbableBlocks = (blocks) => blocks.every((b) => b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string' && Object.keys(b).every((k) => STUB_BLOCK_KEYS.has(k)));
const BINARY_BLOCK_TYPES = new Set(['image', 'audio', 'resource', 'resource_link']);
function isBinaryBlock(b) {
  if (!b || typeof b !== 'object' || b.type === 'text') return false;
  if (BINARY_BLOCK_TYPES.has(b.type) || typeof b.data === 'string' || typeof b.blob === 'string') return true;
  return !!b.resource && typeof b.resource === 'object' && typeof b.resource.blob === 'string';
}
function stubValue(result, text) {
  if (typeof result === 'string') return text;
  if (Array.isArray(result)) return stubbableBlocks(result) ? [{ type: 'text', text }] : null;
  if (result && typeof result === 'object') {
    if (Array.isArray(result.content)) return stubbableBlocks(result.content) ? { ...result, content: [{ type: 'text', text }] } : null;
    if (typeof result.text === 'string') return isBinaryBlock(result) ? null : { ...result, text };
  }
  return null;
}
// The text payload a stub replaces (never the envelope around it).
function payloadOf(result) {
  if (stubValue(result, '') === null) return null;
  const join = (blocks) => blocks.map((b) => b.text).join('\n\n');
  const payload = typeof result === 'string' ? result : Array.isArray(result) ? join(result) : Array.isArray(result.content) ? join(result.content) : result.text;
  return { payload, bytes: utf8(payload) };
}
const blocksOf = (x) => (Array.isArray(x) ? x : (x && Array.isArray(x.content) ? x.content : null));

// A block array that cannot collapse into one stub gets one stub per over-limit block; each names the
// spill of THAT block's original text, and a lossy block kept in place gets its own handle.
function blockStubs(originalBlocks, blocks, tool, format, stubLimit, reason, spills) {
  if (blocks.some(isBinaryBlock)) return null;
  const isText = (b) => !!b && typeof b === 'object' && typeof b.text === 'string';
  const sourceText = (b, i) => (originalBlocks[i] && typeof originalBlocks[i].text === 'string' ? originalBlocks[i].text : b.text);
  let main = null;
  let mainBytes = 0;
  let mainFormat = format;
  let firstStub = null;
  const out = blocks.map((b, i) => {
    if (!isText(b) || utf8(b.text) <= stubLimit) return b;
    const text = sourceText(b, i);
    const s = keep(spill.writeOriginal(text));
    if (!s) return b;
    spills.push(s.path);
    const st = emit.stubFor(tool, text, format, s.path, reason, true);
    if (utf8(b.text) > mainBytes) { main = s.path; mainBytes = utf8(b.text); mainFormat = st.format; }
    if (!firstStub) firstStub = { index: i, render: st.render };
    return { ...b, text: st.render(null) };
  });
  if (!main) return null;
  for (let i = 0; i < out.length; i++) {
    if (out[i] !== blocks[i] || !isText(out[i])) continue;
    const text = sourceText(blocks[i], i);
    if (blocks[i].text === text) continue;
    const s = keep(spill.writeOriginal(text));
    if (!s) return null;
    spills.push(s.path);
    out[i] = { ...out[i], text: `${out[i].text}\n\n<<full=${s.path} original_block>>` };
  }
  return { blocks: out, spill: main, format: mainFormat, firstStub };
}

function runMcp(input, base) {
  const tool = base.tool;
  let result = input.tool_response;
  let hostFile = null;
  let noticeBytes;
  let stubSpills = false;
  const spills = [];
  const parts = [];
  const rec = (decision, reason, bytesIn, bytesOut, x) => recordOf(base, decision, reason, bytesIn, bytesOut, { spills, ...x });
  const pass = (reason, bytes, x) => ({ decision: 'passthrough', reason, record: rec('passthrough', reason, bytes, bytes, x) });
  // An expanded host file is measured against the notice the model would have seen in its place.
  const replace = (decision, reason, built, bytesIn, x) => ({ decision, reason: reason || null, result: built.value, figure: built.line, record: rec(decision, reason, bytesIn, built.bytes, { bytesSeen: noticeBytes, ...x }) });

  if (result === undefined || result === null) return pass('no-result', 0);
  if (typeof result === 'object' && result.isError === true) return pass('error-shape', bytesOf(result));
  let serialized;
  try { serialized = typeof result === 'string' ? result : JSON.stringify(result); } catch (_) { return pass('transform-error', 0); }
  let bytesIn = utf8(serialized);
  const sessionId = base.sessionId;
  const isSlim = (r, b) => emit.alreadySlim(mcpTexts(r), b, env.alreadySlimBound(), sessionId);

  // A slimmed result can quote the phrase above its own host-file handle: it is not a fresh notice.
  const notice = isSlim(result, bytesIn) ? null : overflowSpill(serialized);
  if (notice) {
    const host = spill.readHost(notice, sessionId);
    if (!host.file) return pass(host.why, bytesIn);
    hostFile = host.file;
    noticeBytes = bytesIn;
    const blocks = hostBlocks(host.text);
    result = expandedShape(result, host.text, blocks);
    // A stub's recipe over a block wrapper recovers nothing, so a multi-block payload spills its own copy.
    if (blocks && blocks.length > 1 && blocksOf(result)) stubSpills = true;
    serialized = typeof result === 'string' ? result : JSON.stringify(result);
    bytesIn = utf8(serialized);
  }
  if (input.is_error === true) return pass('error-shape', bytesIn);
  if (isSlim(result, bytesIn)) return pass('already-slim', bytesIn);
  if (bytesIn <= ch.GATES.mcp) {
    const overflow = hostFile ? null : overflowSpill(serialized);
    return pass(overflow ? 'platform-overflow' : 'size-gate', bytesIn, { spill: overflow });
  }

  // The host already ruled an expanded payload too big for context: the stub escape hatch never applies.
  const stubOn = env.stubEnabled() || !!hostFile;
  const stubLimit = env.stubBytes();
  const budget = env.budgetMs();
  const deadline = budget === 0 ? null : (budget < 0 ? Date.now() - 1 : Date.now() + budget);
  const slimmed = slimResult(result, deadline, parts, stubOn ? stubLimit : null);
  const budgetPartial = slimmed.modified && slimmed.budgetBailed > 0;
  const x = (o) => ({ budgetPartial, ...o });

  const tryStub = (reason, stages) => {
    const p = payloadOf(result);
    if (p === null || p.bytes <= stubLimit) return null;
    const own = stubSpills ? null : hostFile;
    const s = own ? { path: own } : keep(spill.writeOriginal(p.payload));
    if (!s) return null;
    if (!own) spills.push(s.path);
    const st = emit.stubFor(tool, p.payload, slimmed.format, s.path, reason, false);
    const built = emit.withStats((stats) => stubValue(result, st.render(stats)), 'stub', bytesIn);
    if (!built) return null;
    return replace('stubbed', hostFile ? 'mod-expand' : reason, built, bytesIn, x({ stages, spill: s.path, format: st.format, engine: 'stub' }));
  };

  const tryBlockStubs = (reason, stages, value) => {
    const blocks = blocksOf(value);
    const originals = blocksOf(result);
    if (!blocks || !originals) return null;
    const s = blockStubs(originals, blocks, tool, slimmed.format, stubLimit, reason, spills);
    if (!s) return null;
    const shape = (bs) => (Array.isArray(value) ? bs : { ...value, content: bs });
    const built = emit.withStats((stats) => shape(stats === null ? s.blocks
      : s.blocks.map((b, i) => (i === s.firstStub.index ? { ...b, text: s.firstStub.render(stats) } : b))), 'stub', bytesIn);
    // Every kept block pays a handle, so a long array of thin blocks can come out bigger than it went in.
    if (!built || built.bytes >= bytesIn) return null;
    if (!writeParts(parts, emittedStrings(built.value), spills)) return null;
    return replace('stubbed', hostFile ? 'mod-expand' : reason, built, bytesIn, x({ stages, spill: s.spill, format: s.format, engine: 'stub' }));
  };

  if (!slimmed.modified) {
    // `!anyError`: `reason` names only the first block, so [whale, error envelope] must not stub.
    const stubbable = stubOn && bytesIn > stubLimit && STUB_REASONS.has(slimmed.reason) && !slimmed.anyError &&
      !(hostFile && slimmed.reason === 'budget-exceeded');
    const overflow = !hostFile && (env.debugLevel() > 0 || stubbable) && OVERFLOW_PROBE_REASONS.has(slimmed.reason) ? overflowSpill(serialized) : null;
    if (stubbable && !overflow) {
      const stubbed = tryStub(slimmed.reason, []) || tryBlockStubs(slimmed.reason, [], slimmed.value);
      if (stubbed) return stubbed;
    }
    return pass(overflow ? 'platform-overflow' : (slimmed.reason || 'no-gain'), bytesIn, { spill: overflow, format: slimmed.format });
  }

  // Compressed and still over the threshold: stub it. Measured on the text payload, not the envelope.
  if (stubOn && (!slimmed.anyError || hostFile) && bytesOf(slimmed.value) > stubLimit) {
    const body = payloadOf(slimmed.value);
    if (body !== null) {
      if (body.bytes > stubLimit && !slimmed.anyError) {
        const stubbed = tryStub('weak-gain', slimmed.stages);
        if (stubbed) return stubbed;
      }
    } else if (!slimmed.anyError) {
      const stubbed = tryBlockStubs('weak-gain', slimmed.stages, slimmed.value);
      if (stubbed) return stubbed;
    }
    if (hostFile && (body === null || body.bytes > stubLimit)) return pass('expand-oversize', bytesIn, { stages: slimmed.stages });
  }

  // Recovery net: no copy of the original → no lossy result.
  const full = hostFile ? { path: hostFile } : keep(spill.writeOriginal(serialized));
  if (!full) return pass('spill-write-failure', bytesIn);
  if (!hostFile) spills.push(full.path);
  const built = emit.withStats((stats) => attachMarker(slimmed, emit.tail(stats, full.path)), 'compressed', bytesIn);
  if (built === null) return pass('transform-error', bytesIn);
  // The gain gates upstream measure the block before the handle; a thin win can come out net bigger.
  if (built.bytes >= bytesIn) return pass('marker-overhead', bytesIn, { stages: slimmed.stages });
  if (!writeParts(parts, emittedStrings(built.value), spills)) return pass('spill-write-failure', bytesIn);
  return replace('compressed', hostFile ? 'mod-expand' : null, built, bytesIn, x({ stages: slimmed.stages, spill: full.path, engine: engineOf(slimmed) }));
}

function channelGuard(channel, input) {
  const ti = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  if (channel === 'bash') {
    const cmd = typeof ti.command === 'string' ? ti.command : '';
    if (ch.OWN_CLI.test(cmd)) return 'own-cli';
    const words = ch.commandWords(cmd);
    if (words.some((w) => w.startsWith('/') && spill.isSpillOrHostFile(w))) return 'spill-read';
    if (words.some((w) => /\.json$/i.test(w) && ch.isSourceJson(w))) return 'read-guard';
  }
  if (channel === 'read') {
    if (ti.offset !== undefined || ti.limit !== undefined || ti.pages !== undefined) return 'windowed-read';
    if (spill.isSpillOrHostFile(ti.file_path)) return 'spill-read';
  }
  if (channel === 'attachment' && typeof ti.path === 'string') {
    if (spill.isSpillOrHostFile(ti.path)) return 'spill-read';
    if (ch.isSourceJson(ti.path)) return 'read-guard';
  }
  return null;
}

// Read compresses only a data file the host did not show whole; anything else is an editable file.
function readAdmits(input, rec) {
  const fp = String((input.tool_input && input.tool_input.file_path) || (rec.file && rec.file.filePath) || '');
  const ext = path.extname(fp).toLowerCase();
  const truncated = !!(rec.file && rec.file.truncatedByTokenCap);
  if (ch.READ_LOG_EXT.has(ext)) return truncated || utf8(rec.file.content) > ch.GATES.read;
  return ext === '.json' && truncated && !ch.isSourceJson(fp);
}

// One text of a non-MCP channel → { out, engine, ... } or { pass }.
function slimChannelText(channel, text, opts) {
  const sniffed = sniff({ data: text });
  if (sniffed.engine === 'binary') return { pass: 'binary' };
  if (sniffed.engine === 'none') return { pass: 'size-gate' };
  const engine = ch.admit(channel, sniffed.engine, opts.command);
  if (engine === null) return { pass: 'read-guard' };
  const bytes = utf8(text);
  const gate = ch.structuredGate(channel, engine, opts.plainBytes);
  if (gate !== null && bytes <= gate) return { pass: 'size-gate' };
  // A JSON view or a node tree over the egress cap is stubbed, so the engine is asked to fit under it first.
  const run = (e) => compress({ data: text }, engineOptions(opts.deadline, {
    engine: e, budgetBytes: opts.window, plainBytes: ch.plainGate(channel, opts.plainBytes),
    targetBytes: ['json', 'jsonl', 'figma-nodes'].includes(e) ? opts.egress || null : null,
  }));
  let r = run(engine);
  // A node tree its depth fold cannot fit would pass through raw; the JSON route can still fit it or stub it.
  if (r.decision === 'compressed' && r.engine === 'figma-nodes' && utf8(r.text) > (opts.egress || Infinity)) r = run('json');
  if (r.decision !== 'compressed') return { pass: r.reason || 'no-gain', format: r.format, engine };
  return { out: r.text, engine: r.engine, stages: r.stats.stages, parts: r.parts || [], window: r.window, json: r.engine === 'json' || r.engine === 'jsonl', ext: ['json', 'jsonl', 'figma-nodes'].includes(r.engine) ? '.json' : '.txt' };
}

function runChannel(input, base) {
  const channel = base.channel;
  const rec = input.tool_response;
  const spills = [];
  const pass = (reason, bytes, x) => ({ decision: 'passthrough', reason, record: recordOf(base, 'passthrough', reason, bytes, bytes, { spills, ...x }) });
  if (rec === undefined || rec === null) return pass('no-result', 0);
  const ex = ch.extract(channel, rec, input);
  const visible = ex.texts ? ex.texts.reduce((n, t) => n + utf8(t), 0) : bytesOf(rec);
  if (ex.pass) return pass(ex.pass, visible);
  if (input.is_error === true) return pass('error-shape', visible);
  const guard = channelGuard(channel, input);
  if (guard) return pass(guard, visible);
  if (emit.alreadySlim(ex.texts, visible, env.alreadySlimBound(), base.sessionId)) return pass('already-slim', visible);
  if (channel === 'read' && !readAdmits(input, rec)) return pass('read-guard', visible);

  const ti = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  const command = typeof ti.command === 'string' ? ti.command : '';
  const plainBytes = env.plainBytes();
  const budget = env.budgetMs();
  // The host caches an attachment's answer and asks again after a compaction: no deadline, so it is
  // the same answer every time.
  const deadline = budget === 0 || channel === 'attachment' ? null : (budget < 0 ? Date.now() - 1 : Date.now() + budget);
  const window = channel === 'grep' ? ch.WINDOW.grep : ch.WINDOW.other;
  const inline = channel === 'bash' ? env.bashInline(input.bash_output_max_chars) : null;
  // The host counts the characters (.length) of stdout and stderr together; past its limit it would
  // save slim's own answer to a file and show only a preview of it.
  const stderrChars = String(rec.stderr || '').length;
  const opts = { command, plainBytes, deadline, window, egress: inline === null ? ch.EGRESS[channel] : ch.bashEgress(inline - stderrChars) };

  if (ex.items) return runItems(input, base, ex, opts, spills, pass);

  let text = ex.single.text;
  let hostFile = null;
  let bytesSeen;
  if (ex.persisted) {
    const host = spill.readHost(ex.persisted, base.sessionId);
    if (!host.file) return pass(host.why, visible);
    hostFile = host.file;
    text = host.text;
    bytesSeen = ch.bashSeen(ex.persisted, Number.isFinite(rec.persistedOutputSize) ? rec.persistedOutputSize : utf8(text));
    opts.window = ch.WINDOW.bashPersisted;
    // The model saw only the host's 2 KB preview, so the window beats it whatever SLIM_PLAIN_BYTES says.
    opts.plainBytes = ch.WINDOW.bashPersisted;
  } else if (channel === 'read' && rec.file.truncatedByTokenCap) {
    const whole = spill.readLocal(ti.file_path || rec.file.filePath);
    if (!whole.file) return pass(whole.why, visible);
    text = whole.text;
    bytesSeen = visible;
  } else if (channel === 'attachment') {
    bytesSeen = visible;
  }
  const bytesIn = utf8(text);
  const s = slimChannelText(channel, text, opts);
  if (s.pass) return pass(s.pass, bytesIn, { format: s.format });

  const egress = opts.egress;
  const hint = channel === 'bash' && s.engine === 'html' && env.hintOn() && ch.FETCH_CMD.test(command) ? emit.hintLine(command, cwdOf(input)) : null;
  const note = channel === 'read' || channel === 'attachment' ? emit.readNote() : null;
  const extras = [note, hint].filter(Boolean).map((l) => `\n\n${l}`).join('');
  const original = hostFile ? { path: hostFile } : keep(spill.writeOriginal(text, s.ext));
  if (!original) return pass('spill-write-failure', bytesIn);
  if (!hostFile) spills.push(original.path);
  const reason = hostFile ? 'mod-expand' : null;

  const persistedByHost = (value) => inline !== null && value.length + stderrChars >= inline;
  const capped = () => {
    if (!s.json && s.engine !== 'figma-nodes') return pass('egress-cap', bytesIn);
    const st = emit.stubFor(base.tool, text, 'json', original.path, 'egress-cap', false);
    const built = emit.withStats((stats) => st.render(stats), 'stub', bytesIn, utf8);
    if (persistedByHost(built.value)) return pass('egress-cap', bytesIn);
    return {
      decision: 'stubbed', reason: 'egress-cap', result: ex.single.rebuild(built.value), figure: built.line,
      record: recordOf(base, 'stubbed', 'egress-cap', bytesIn, built.bytes, { spills, spill: original.path, engine: 'stub', stages: s.stages, bytesSeen }),
    };
  };
  if (utf8(s.out) > egress) return capped();
  const built = emit.withStats((stats) => `${s.out}${extras}${emit.tail(stats, original.path)}`, 'compressed', bytesIn, utf8);
  if (built.bytes >= bytesIn) return pass('marker-overhead', bytesIn);
  if (persistedByHost(built.value)) return capped();
  if (!writeParts(s.parts, [built.value], spills)) return pass('spill-write-failure', bytesIn);
  return {
    decision: 'compressed', reason, result: ex.single.rebuild(built.value), figure: built.line,
    record: recordOf(base, 'compressed', reason, bytesIn, built.bytes, { spills, spill: original.path, engine: s.engine, stages: s.stages, window: s.window, hint: !!hint, bytesSeen }),
  };
}

// WebSearch results and an agent's text blocks: each text over the plain threshold is windowed on
// its own and carries its own handle; the rest stay untouched.
function runItems(input, base, ex, opts, spills, pass) {
  const bytesIn = ex.texts.reduce((n, t) => n + utf8(t), 0);
  const outs = [];
  let bytesOut = bytesIn;
  let main = null;
  let window = null;
  for (const item of ex.items) {
    const s = slimChannelText(base.channel, item.text, opts);
    if (s.pass) continue;
    const original = keep(spill.writeOriginal(item.text, '.txt'));
    if (!original) return pass('spill-write-failure', bytesIn);
    spills.push(original.path);
    const itemIn = utf8(item.text);
    const built = emit.withStats((stats) => `${s.out}${emit.tail(stats, original.path)}`, 'compressed', itemIn, utf8);
    if (built.bytes >= itemIn) continue;
    outs.push([item.index, built.value, built.line]);
    bytesOut += built.bytes - itemIn;
    if (!main) { main = original.path; window = s.window; }
  }
  if (!outs.length) return pass('plain-gate', bytesIn);
  return {
    decision: 'compressed', reason: null, result: ex.rebuildItems(outs.map(([i, v]) => [i, v])), figure: outs[0][2],
    record: recordOf(base, 'compressed', null, bytesIn, bytesOut, { spills, spill: main, engine: 'text', window }),
  };
}

function run(input, t0) {
  const channel = typeof input.channel === 'string' ? input.channel : 'mcp';
  const base = {
    t0, channel, tool: typeof input.tool === 'string' ? input.tool : null,
    toolUseId: typeof input.tool_use_id === 'string' && input.tool_use_id ? input.tool_use_id : null,
    sessionId: typeof input.session_id === 'string' ? input.session_id : '',
  };
  if (PRE_REASONS.has(input.pre)) {
    const b = Number.isFinite(input.bytes_in) ? input.bytes_in : 0;
    const shape = input.tool_input && typeof input.tool_input.shape === 'string' ? input.tool_input.shape : undefined;
    return { decision: 'passthrough', reason: input.pre, record: recordOf(base, 'passthrough', input.pre, b, b, { format: shape }) };
  }
  if (channel === 'mcp') return runMcp(input, base);
  if (!ch.CHANNELS.includes(channel)) {
    return { decision: 'passthrough', reason: 'unrecognized-shape', record: recordOf({ ...base, channel: String(channel).slice(0, 32) }, 'passthrough', 'unrecognized-shape', 0, 0) };
  }
  return runChannel(input, base);
}

// An answer over the hooks module's stdout ceiling would arrive truncated and be thrown away there;
// answer passthrough instead, so neither the spills nor the log claim a saving nobody received.
function capAnswer(answer, cap = OUTPUT_CAP, drop) {
  if (!answer || (answer.decision !== 'compressed' && answer.decision !== 'stubbed')) return answer;
  if (utf8(JSON.stringify(answer)) <= cap) return answer;
  const r = answer.record;
  const spills = typeof drop === 'function' ? drop() : r.spills;
  return {
    decision: 'passthrough', reason: 'output-cap',
    record: { ...r, decision: 'passthrough', reason: 'output-cap', engine: null, bytes_out: r.bytes_in, pct: 0, spill: null, spills },
  };
}

function errorRecord(entry, input, name, message, ms) {
  return {
    src: 'slim', channel: typeof input.channel === 'string' ? input.channel.slice(0, 32) : 'mcp', entry,
    tool: typeof input.tool === 'string' ? input.tool : null,
    ...(typeof input.tool_use_id === 'string' && input.tool_use_id ? { tool_use_id: input.tool_use_id } : {}),
    decision: 'error', reason: String(name || 'Error'), engine: null,
    bytes_in: 0, bytes_out: 0, pct: 0, stages: [], spill: null, ms, error: String(message ?? '').slice(0, 200),
  };
}

// JSON.parse quotes the input in its message; the log never carries payload.
function parseEnvelope(raw) {
  let v;
  try { v = JSON.parse(raw); } catch (_) { throw new SyntaxError('stdin is not a JSON envelope'); }
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}
const cwdOf = (input) => (input && typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd());

function handleResult(raw) {
  const t0 = Date.now();
  let input = {};
  let answer;
  created = [];
  const dropAll = () => { spill.unlinkAll(created); created = []; return []; };
  try {
    input = parseEnvelope(raw);
    answer = run(input, t0);
    if (answer.decision === 'passthrough') dropAll();
    else {
      const named = emittedStrings(answer.result);
      spill.unlinkAll(created.filter((p) => !named.some((s) => s.includes(p))));
    }
    answer = capAnswer(answer, OUTPUT_CAP, dropAll);
  } catch (e) {
    try { dropAll(); } catch (_) {}
    answer = { decision: 'error', reason: String((e && e.name) || 'Error') };
    answer.record = errorRecord('hook', input, answer.reason, e && e.message, Date.now() - t0);
  }
  process.stdout.write(JSON.stringify(answer));
  if (input.record !== false || answer.decision === 'error') rep.writeLine(answer.record, cwdOf(input));
  spill.sweep();
}

function handleError(raw) {
  let input = {};
  let name;
  let message;
  try {
    input = parseEnvelope(raw);
    const err = input.error && typeof input.error === 'object' ? input.error : {};
    name = err.name;
    message = err.message;
  } catch (e) {
    name = e.name;
    message = e.message;
  }
  rep.appendLine(errorRecord('mod', input, name, message, 0), cwdOf(input));
}

const LOOKUP_DECISIONS = new Set(['answered', 'failed', 'refused']);
const LOOKUP_RUNGS = new Set(['url', 'webfetch', 'path', 'command']);
const VIEW_DECISIONS = new Set(['compressed', 'narrowed', 'passthrough', 'cached', 'refused']);
function handleRecord(raw) {
  let input = {};
  try { input = parseEnvelope(raw); } catch (_) { return; }
  const num = (v) => (Number.isFinite(v) ? v : 0);
  if (input.channel === 'view') {
    // Image and video bytes never head for the context: kept apart, they would swamp the savings totals.
    const media = input.engine === 'media';
    const bytesIn = media ? 0 : num(input.bytes_in);
    const bytesOut = media ? 0 : num(input.bytes_out);
    rep.writeLine({
      src: 'slim', channel: 'view', entry: 'mod', tool: 'mcp__slim__view',
      ...(typeof input.tool_use_id === 'string' && input.tool_use_id ? { tool_use_id: input.tool_use_id } : {}),
      decision: VIEW_DECISIONS.has(input.decision) ? input.decision : 'refused',
      reason: typeof input.reason === 'string' ? input.reason.slice(0, 80)
        : input.decision === 'narrowed' ? 'jq-narrowed' : input.decision === 'cached' ? 'cached' : null,
      rung: input.rung === 'path' || input.rung === 'command' ? input.rung : null,
      engine: typeof input.engine === 'string' ? input.engine.slice(0, 16) : null,
      bytes_in: bytesIn, bytes_out: bytesOut, pct: input.narrowed === true ? 0 : pctOf(bytesIn, bytesOut),
      stages: Array.isArray(input.stages) ? input.stages.filter((x) => typeof x === 'string').slice(0, 16) : [],
      spill: typeof input.spill === 'string' ? input.spill : null,
      ...(input.narrowed === true ? { narrowed: true } : {}),
      ...(Number.isFinite(input.frames) && input.frames > 0 ? { frames: input.frames } : {}),
      ...(media ? { media_in: num(input.bytes_in), media_out: num(input.bytes_out) } : {}),
      ms: num(input.ms),
    }, cwdOf(input));
    return;
  }
  const t = input.tokens && typeof input.tokens === 'object' ? input.tokens : null;
  const bytesIn = num(input.bytes_in);
  const bytesOut = num(input.bytes_out);
  rep.writeLine({
    src: 'slim', channel: 'lookup', entry: 'mod', tool: 'mcp__slim__lookup',
    ...(typeof input.tool_use_id === 'string' && input.tool_use_id ? { tool_use_id: input.tool_use_id } : {}),
    decision: LOOKUP_DECISIONS.has(input.decision) ? input.decision : 'failed',
    reason: typeof input.reason === 'string' ? input.reason.slice(0, 80) : null,
    rung: LOOKUP_RUNGS.has(input.rung) ? input.rung : null,
    engine: typeof input.engine === 'string' ? input.engine.slice(0, 16) : null,
    model: typeof input.model === 'string' ? input.model.slice(0, 64) : null,
    tokens: t ? { input: num(t.input), output: num(t.output), cache_read: num(t.cache_read), cache_creation: num(t.cache_creation) } : null,
    bytes_in: bytesIn, bytes_out: bytesOut, pct: pctOf(bytesIn, bytesOut), stages: [], spill: null, ms: num(input.ms),
  }, cwdOf(input));
}

// JSON (or JSON lines) with every array element and object member down to depth 2 on its own line, so a
// line window cuts between rows, never through one. Null when the text is neither.
function rowLines(text) {
  const t = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
  let v;
  try { v = JSON.parse(t); } catch (_) {
    const rows = t.split('\n').filter((l) => l.trim());
    try { rows.forEach((l) => JSON.parse(l)); return rows.join('\n'); } catch (_) { return null; }
  }
  const out = [];
  const walk = (x, depth, prefix) => {
    if (depth >= 2 || x === null || typeof x !== 'object') { out.push(prefix + JSON.stringify(x)); return; }
    const arr = Array.isArray(x);
    out.push(prefix + (arr ? '[' : '{'));
    for (const [k, c] of Object.entries(x)) walk(c, depth + 1, `${'  '.repeat(depth + 1)}${arr ? '' : `${JSON.stringify(k)}: `}`);
    out.push(`${'  '.repeat(depth)}${arr ? ']' : '}'}`);
  };
  walk(v, 0, '');
  return out.join('\n');
}

// A document for a small model to answer one question from: the text distilled to fit a budget.
function handleDistill(raw) {
  const reply = (o) => process.stdout.write(JSON.stringify({ v: 1, ...o }));
  let input;
  try { input = parseEnvelope(raw); } catch (_) { reply({ decision: 'refused', engine: 'none', reason: 'bad-input', text: '', bytesIn: 0, bytesOut: 0 }); return; }
  const budget = Number.isFinite(input.budgetBytes) && input.budgetBytes > 0 ? input.budgetBytes : DISTILL_BUDGET;
  let text;
  if (typeof input.text === 'string') text = input.text;
  else if (typeof input.path === 'string') {
    const f = spill.readLocal(input.path);
    if (!f.file) { reply({ decision: 'refused', engine: 'none', reason: f.why, text: '', bytesIn: 0, bytesOut: 0 }); return; }
    text = f.text;
  } else if (typeof input.host_path === 'string') {
    const h = spill.readHost(input.host_path, input.session_id);
    if (!h.file) { reply({ decision: 'refused', engine: 'none', reason: h.why, text: '', bytesIn: 0, bytesOut: 0 }); return; }
    text = h.text;
  } else { reply({ decision: 'refused', engine: 'none', reason: 'bad-input', text: '', bytesIn: 0, bytesOut: 0 }); return; }
  const hint = input.hint && typeof input.hint === 'object' ? input.hint : undefined;
  let r = compress({ data: text, hint }, { budgetBytes: budget, plainBytes: budget, maxMs: env.budgetMs() || 0 });
  // A crush cites its dropped rows by a file nothing here writes: the model would see a dangling handle
  // and miss the facts in those rows. One row per line, windowed, keeps every row the budget can hold.
  if (r.parts && r.parts.some((p) => p.kind === 'rows')) {
    const lines = rowLines(text);
    if (lines !== null) {
      const w = compress({ data: lines }, { engine: 'text', budgetBytes: budget, plainBytes: budget, maxMs: 0 });
      r = { ...w, engine: r.engine, decision: 'compressed', reason: 'rows-inline' };
    }
  }
  if (r.decision !== 'refused' && utf8(r.text) > budget) {
    const w = compress({ data: r.text }, { engine: 'text', budgetBytes: budget, plainBytes: budget, maxMs: 0 });
    r = { ...w, engine: r.engine, decision: 'compressed', reason: undefined };
  }
  reply({ decision: r.decision, engine: r.engine, ...(r.reason ? { reason: r.reason } : {}), text: r.text, bytesIn: utf8(text), bytesOut: utf8(r.text) });
}

// The view tool's core: the reply on stdout; a reply over the hooks module's ceiling is refused and
// the files it named are removed.
function handleView(raw) {
  const created = [];
  let input = {};
  let reply;
  try {
    input = parseEnvelope(raw);
    const budget = env.budgetMs();
    const deadline = budget === 0 ? null : (budget < 0 ? Date.now() - 1 : Date.now() + budget);
    reply = viewCore().view(input, { created, engineOptions: engineOptions(deadline, {}) });
    if (utf8(JSON.stringify(reply)) > OUTPUT_CAP) {
      spill.unlinkAll(created);
      const message = reply.write
        ? 'view: the compact text is over 4 MiB even for out — narrow with jq, or Read the source windowed'
        : 'view: the compact text is over 4 MiB — pass out (under .claude/tasks/<id>/) or narrow with jq';
      reply = { v: 1, decision: 'refused', reason: 'output-cap', engine: reply.engine, figure: message, text: message, bytesIn: reply.bytesIn, bytesOut: 0, stages: [] };
    }
  } catch (e) {
    try { spill.unlinkAll(created); } catch (_) {}
    const message = `view: failed (${(e && e.name) || 'Error'})`;
    reply = { v: 1, decision: 'refused', reason: 'error', engine: null, figure: message, text: message, bytesIn: 0, bytesOut: 0, stages: [] };
  }
  process.stdout.write(JSON.stringify(reply));
  spill.sweep();
}

// The prompt channel: the rewritten prompt on stdout, one report line; a reply that is not a rewrite,
// or one over the hooks module's ceiling, leaves no spill behind.
function handlePrompt(raw) {
  const t0 = Date.now();
  const run = { created: [], journal: null };
  let input = {};
  let reply;
  try {
    input = parseEnvelope(raw);
    reply = promptCore().rewrite(input, run);
    if (reply.decision === 'rewritten' && utf8(JSON.stringify(reply)) > OUTPUT_CAP) reply = { v: 1, decision: 'passthrough', reason: 'output-cap', bytesIn: reply.bytesIn, bytesOut: reply.bytesIn, spans: [] };
  } catch (e) {
    reply = { v: 1, decision: 'passthrough', reason: String((e && e.name) || 'Error'), bytesIn: 0, bytesOut: 0, spans: [] };
  }
  const rewritten = reply.decision === 'rewritten';
  if (!rewritten) promptCore().settle(run, false);
  process.stdout.write(JSON.stringify(reply));
  if (rewritten) promptCore().settle(run, true);
  const spills = rewritten ? reply.spans.map((x) => x.spill) : [];
  rep.writeLine({
    src: 'slim', channel: 'prompt', entry: 'mod', tool: 'prompt', decision: rewritten ? (reply.form === 'head' ? 'stubbed' : 'compressed') : 'passthrough',
    reason: rewritten ? null : reply.reason, engine: rewritten ? reply.engine : null, bytes_in: reply.bytesIn, bytes_out: reply.bytesOut,
    pct: pctOf(reply.bytesIn, reply.bytesOut), stages: reply.stages || [], spill: spills[0] || null, spills, ms: Date.now() - t0,
    ...(rewritten ? { spans: reply.spans.length } : {}),
  }, cwdOf(input));
}

// A rewrite the session never took: its spills go (delivery/prompt.cjs `drop`).
function handlePromptDrop(raw) {
  try { promptCore().drop(parseEnvelope(raw)); } catch (_) {}
}

const ACCESS_TOOLS = { Read: 'read', Bash: 'bash', Grep: 'grep' };
const ACCESS_MAX = 8;
// A model's Read, Bash or Grep that named slim's spills: one access line per file that exists, so
// --report pairs the recovery with the whale it followed; a read the guard denied is marked `denied`
// and never paired. Debug artefact: nothing at level 0.
function handleAccess(raw) {
  let input = {};
  try { input = parseEnvelope(raw); } catch (_) { return; }
  if (!env.debugLevel()) return;
  const channel = ACCESS_TOOLS[input.tool];
  if (!channel || !Array.isArray(input.spills)) return;
  const via = typeof input.via === 'string' && /^[\w-]{1,16}$/.test(input.via) ? input.via : 'other';
  const seen = new Set();
  for (const p of input.spills.slice(0, ACCESS_MAX)) {
    if (typeof p !== 'string' || !path.isAbsolute(p) || seen.has(p)) continue;
    seen.add(p);
    if (!fs.existsSync(p)) continue;
    rep.appendLine({ src: 'slim', channel, entry: 'access', tool: input.tool, via, spill: p, ...(input.denied === true ? { denied: true } : {}) }, cwdOf(input));
  }
}

function handleReport(args) {
  let file = null;
  let since = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--since' && i + 1 < args.length) since = args[++i];
    else if (a.startsWith('--since=')) since = a.slice('--since='.length);
    else if (a.startsWith('-') || file !== null) { usage(process.stderr); process.exitCode = 2; return; }
    else file = a;
  }
  if (since !== null && Number.isNaN(Date.parse(since))) {
    process.stderr.write(`slim: --since '${since}' is not a date\n`);
    process.exitCode = 1;
    return;
  }
  file = file || path.join(env.spillRoot(), rep.DEBUG_LOG);
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    process.stderr.write(`slim: cannot read ${file} (${(e && e.code) || 'error'})\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${rep.report(text, { file, since })}\n`);
  process.exitCode = 0;
}

function usage(stream) {
  stream.write([
    'usage: node slim.cjs < envelope.json                   compress one tool result (JSON answer on stdout)',
    '       node slim.cjs --distill < request.json          distill a text, file or host file for a lookup',
    '       node slim.cjs --view < request.json             the view tool: one file or output, compact',
    '       node slim.cjs --prompt < request.json           a pasted prompt with its data spans compacted in place',
    '       node slim.cjs --prompt-drop < drop.json         remove the spills of a rewrite the session never took',
    '       node slim.cjs --access < access.json            log a model\'s read of slim\'s spill files',
    '       node slim.cjs --record < record.json            log one lookup or view',
    '       node slim.cjs --error < error.json              log the hooks module\'s own failure',
    '       node slim.cjs --report [logfile] [--since ISO]  report by src and by channel',
  ].join('\n') + '\n');
}

function readStdin(done) {
  // Decoded once at the end: a multibyte character split across chunks must not become U+FFFD.
  const chunks = [];
  process.stdin.on('data', (d) => chunks.push(d));
  process.stdin.on('end', () => done(Buffer.concat(chunks).toString('utf8')));
}

module.exports = { capAnswer, OUTPUT_CAP };

if (require.main === module) {
  const args = process.argv.slice(2);
  process.exitCode = 0;
  const modes = { '--error': handleError, '--distill': handleDistill, '--view': handleView, '--prompt': handlePrompt, '--prompt-drop': handlePromptDrop, '--access': handleAccess, '--record': handleRecord };
  if (args.length === 0) readStdin(handleResult);
  else if (args.length === 1 && modes[args[0]]) readStdin(modes[args[0]]);
  else if (args[0] === '--report') handleReport(args.slice(1));
  else if (args.length === 1 && args[0] === '--help') usage(process.stdout);
  else { usage(process.stderr); process.exitCode = 2; }
}
