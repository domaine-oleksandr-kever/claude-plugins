// OpenCode plugin adapter for the fnd hooks — wiring only. OpenCode has no JSON hook
// protocol, so this file translates its in-process hook calls into the Claude Code hook
// events the canonical scripts in ../hooks already speak, and applies whatever they answer.
// It carries NO guard, compression or injection logic of its own: every decision still comes
// from hooks/*.cjs|sh, which stay single-copy across all four hosts.
//
//   chat.message         → hooks/user-prompt.cjs   (UserPromptSubmit) + first-message session context
//   tool.execute.before  → hooks/no-ai-attribution.sh + hooks/no-verify-bypass.sh (PreToolUse: Bash),
//                          then hooks/spill-access.sh for the bash / read / grep tools (measurement
//                          only — see recordSpillAccess)
//   tool.execute.after   → hooks/mcp-slim.cjs      (PostToolUse: mcp__*), rewriting the result in place
//                          (a built-in tool's output.output, an MCP tool's raw content blocks)
//   event                → session bookkeeping only
//
// Deliberate divergences from the Claude Code wiring (HARNESS-PORT-PLAN M5):
//   - the sessionStart STATICS (comment discipline, lean code, task workspace, mcp-whale,
//     untrusted content, plugin feedback) are NOT injected here. On OpenCode they belong in the user's
//     `instructions` config (or an AGENTS.md), which costs nothing per message and survives
//     compaction; injecting them from a message hook would re-pay them per session at best.
//     Only the detection-gated store-access block is dynamic, so it is the only one injected —
//     once per session, on the first chat.message (session.created carries no message to
//     attach context to).
//   - a blocked prompt has no analogue here (nothing can erase a message), but a message CAN
//     be rewritten: when the prompt-JSON guard blocks, each blob it already spilled is
//     replaced in place by its `full=` handle, so the paste is offloaded exactly as on Claude
//     Code instead of riding along in every turn.
//   - subagent-conventions.sh has no OpenCode event (no subagent-start hook); the generated
//     agents-opencode/*.md carry those conventions in the agent body instead, and the
//     untrusted-content rail rides in the `instructions` list above with the other statics.
//   - hooks/scratch-path-guard.cjs (the PreToolUse screenshot-path deny, M3) is NOT wired here:
//     tool.execute.before only sees the bash tool in this adapter, and the MCP tool-name/arg
//     shapes OpenCode hands it are unverified — skipped rather than faked. It is wired on every
//     other host (Claude Code, Codex, and Cursor's beforeMCPExecution); on this one the
//     task-workspace convention is the instruction-only rail (references/task-workspace.md).
//
// FND_HOST=opencode is set on the process — this host has no hook COMMANDS to carry the tag, and
// it is the `host` column of the FND_HOST_TRACE log. The adapter traces the two events it
// COMPOSES (the session-context injection, and each chat.message); every canonical script it
// spawns writes its own line, so a guard verdict is never recorded twice.
//
// Fail-open everywhere except the commit guard: an explicit exit 2 from either git guard throws
// (OpenCode's block primitive), and a no-verify guard that reaches NO verdict at all — no bash, a
// missing file, a timeout — throws too, but only on the commands it would have inspected. A guard
// that cannot run is a broken install, not an allow, and letting a `--no-verify` through on the
// strength of an install defect is the one outcome this layer exists to prevent (same rule as the
// Cursor shim). The attribution guard stays best-effort. permission-fragment.example.json is the
// declarative backstop for `--auto` runs and for an adapter that never loaded at all.
//
// The .cjs cores are spawned as real `node` processes rather than imported, so this adapter
// never depends on Bun's CJS interop and the scripts run byte-identically to Claude Code.
// (M1c verifies `node` is on OpenCode's PATH; Bun-specific behavior is M10c.)
//
// ONE export on purpose: a loader that registers every exported function would otherwise
// double-wire the hooks, which means double injection and a second compression pass.
//
// The `.js` extension and ESM syntax are what OpenCode's Bun plugin loader requires; this file
// therefore cannot be run under plain `node` without `--input-type=module`. Everything else in
// the bundle stays `.cjs` for exactly that reason — only this adapter is loaded by Bun.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// Resolved from this file, never from CURSOR_/CLAUDE_PLUGIN_ROOT: those leak between
// concurrently running plugins on at least one host, and a guard that reads the wrong root
// silently stops guarding.
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOKS = path.join(PLUGIN_ROOT, 'hooks');

// Domaine env files fill process.env gaps (env > project > global) — the fast gates below read
// process.env, and every spawned .cjs core inherits the result. Single-copy: the loader is the
// same scripts/env-file.cjs the other hosts use (Bun resolves CJS through createRequire).
try {
  createRequire(import.meta.url)(path.join(PLUGIN_ROOT, 'scripts', 'env-file.cjs')).load();
} catch (_) {} // a broken config file must never take the plugin down

// FND_HOST_TRACE, the host-proof log. This host has no hook COMMANDS to carry the tag, so the
// adapter assigns it — for its own records and, through the inherited spawn env, for every
// canonical script it runs (runScript pins it explicitly too).
process.env.FND_HOST = 'opencode';
let hostTrace = { trace() {}, enabled() { return false; }, start() { return 0; } };
try {
  hostTrace = createRequire(import.meta.url)(path.join(HOOKS, 'host-trace.cjs'));
} catch (_) {} // partial install → no tracing, no crash

const GUARD_TIMEOUT_MS = 10000;
// mcp-slim's own wall-clock budget defaults to 5 s and applies to the pipeline only, so the
// process ceiling has to sit above it plus spawn and I/O of a multi-MB payload.
const SLIM_TIMEOUT_MS = 30000;
const PROMPT_TIMEOUT_MS = 10000;

// Under Bun process.execPath is the Bun binary, so the .cjs cores would run on a runtime they
// were never tested against; take the real node off PATH there.
const NODE_BIN = path.basename(process.execPath || '').startsWith('node') ? process.execPath : 'node';

// OpenCode's own tools. Everything else that carries an underscore is an MCP tool
// (`<server>_<tool>`) — the shape mcp-slim's Claude Code matcher spells `mcp__.*`.
const BUILTIN_TOOLS = new Set([
  'bash', 'edit', 'write', 'read', 'grep', 'glob', 'list', 'patch', 'multiedit',
  'todowrite', 'todoread', 'task', 'skill', 'webfetch', 'question', 'invalid',
]);

function isMcpTool(tool) {
  return typeof tool === 'string' && tool.includes('_') && !BUILTIN_TOOLS.has(tool);
}

// The commit guard's own fast-reject words: a command naming none of them can never be a bypass,
// so it is also the command a broken guard is safe to let through (see tool.execute.before).
// SINGLE SOURCE: hooks/no-verify-bypass.sh — its `case "$input" in *git*|…` line is the list this
// mirrors; hooks/cursor-shim.cjs holds the byte-identical twin (both sims diff the two literals),
// and hooks-cursor.json's `case` glob is a deliberately coarser third copy for the no-node path.
const GIT_TRIGGER = /(^|[^a-z])(git|commit|push|merge|pull)|(^|\s)am(\s|$)/i;

function warn(msg) {
  try {
    process.stderr.write(`fnd opencode adapter: ${msg}\n`);
  } catch (_) {} // a closed stderr must not take the hook down
}

// `atlassian_getJiraIssue` → `mcp__atlassian__getJiraIssue`, so the debug log and
// `json-slim --report` read the same on every host. Server ids holding an underscore split at
// the wrong place; that only mislabels a log line, so the first separator is good enough.
function claudeToolName(tool) {
  const at = tool.indexOf('_');
  return `mcp__${tool.slice(0, at)}__${tool.slice(at + 1)}`;
}

// hooks/spill-access.sh records that SOME tool read an MCP spill, so `json-slim --report` can pair a
// platform-overflow whale with the read that recovered it. Measurement only: it never blocks and its
// status is ignored. OpenCode's read/grep tools DO carry a path argument, so this host records the
// file-reader side too — the arg spellings are unpinned, hence the small candidate list.
const SPILL_ARGS = {
  read: ['filePath', 'file_path', 'path'],
  grep: ['path', 'filePath', 'file_path'],
};

async function recordSpillAccess(claudeTool, args, cwd) {
  try {
    if (process.env.FND_SPILL_ACCESS === '0') return;
    let toolInput;
    if (claudeTool === 'Bash') {
      toolInput = { command: args.command };
    } else {
      const key = SPILL_ARGS[claudeTool === 'Read' ? 'read' : 'grep'].find((k) => typeof args[k] === 'string' && args[k]);
      if (!key) return;
      toolInput = claudeTool === 'Grep' ? { pattern: String(args.pattern || ''), path: args[key] } : { file_path: args[key] };
    }
    await runScript('bash', [path.join(HOOKS, 'spill-access.sh')],
      JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: claudeTool, tool_input: toolInput, cwd }), GUARD_TIMEOUT_MS);
  } catch (_) {} // a measurement hook may never affect the call it measures
}

// Run a hook script to completion. Never rejects: the caller decides what a failure means,
// and for every caller here that decision is "carry on untouched".
function runScript(bin, args, stdin, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      // The plugin-root env is overwritten with the root resolved above: subagent-conventions.sh
      // prefers that env over its own dirname, and a host that leaks another plugin's root would
      // otherwise send a canonical script reading the wrong bundle.
      child = spawn(bin, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        // FND_HOST: the child writes its own trace line, and only the adapter knows the host.
        env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, FND_HOST: 'opencode' },
      });
    } catch (err) {
      resolve({ code: null, stdout: '', stderr: '', error: err });
      return;
    }
    const out = [];
    const err = [];
    let settled = false;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) {}
      finish({ code: null, stdout: '', stderr: '', error: new Error('timeout') });
    }, timeoutMs);
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', (e) => finish({ code: null, stdout: '', stderr: '', error: e }));
    child.on('close', (code) => finish({
      code,
      stdout: Buffer.concat(out).toString('utf8'),
      stderr: Buffer.concat(err).toString('utf8'),
      error: null,
    }));
    child.stdin.on('error', () => {}); // a guard that rejects early closes stdin under our write
    try { child.stdin.end(stdin); } catch (_) {}
  });
}

// The one JSON object a hook script writes on stdout, or null when it wrote nothing.
function parseHookOutput(stdout) {
  const raw = (stdout || '').trim();
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' ? value : null;
  } catch (_) {
    return null;
  }
}

function readFile(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch (_) {
    return null;
  }
}

function textParts(parts) {
  return Array.isArray(parts)
    ? parts.filter((p) => p && p.type === 'text' && typeof p.text === 'string')
    : [];
}

// Context rides on the user's own message: OpenCode has no separate context channel, and
// appending to the last text part is the mutation with the least schema surface (a synthetic
// part has to satisfy whatever fields the server validates).
function injectContext(parts, text) {
  const texts = textParts(parts);
  if (texts.length) {
    const last = texts[texts.length - 1];
    last.text = `${last.text}\n\n${text}`;
    return true;
  }
  if (Array.isArray(parts)) {
    parts.push({ type: 'text', text });
    return true;
  }
  return false;
}

// store-access.md is the one sessionStart block Claude Code gates on project DETECTION rather
// than on an env switch, so it is the one that cannot move into a static instructions file.
// The plugin-root line comes with it because the block's paths are written relative to it.
function dynamicSessionContext(cwd) {
  const shopify = path.join(cwd, 'shopify.theme.toml');
  const dotenv = path.join(cwd, '.env');
  if (!fs.existsSync(shopify) && !fs.existsSync(dotenv)) return null;
  const md = readFile(path.join(HOOKS, 'store-access.md'));
  return md ? `fnd plugin root: ${PLUGIN_ROOT}\n\n${md}` : null;
}

// Offload what the guard already spilled. The guard's block reason names the files it wrote,
// and each one holds the blob's bytes VERBATIM, so the spans it found can be replaced without
// re-deriving them here. Any blob whose bytes are no longer in the message is skipped — the
// prompt is only ever made smaller, never garbled.
function offloadSpilledBlobs(parts, reason) {
  const texts = textParts(parts);
  if (!texts.length) return false;
  let offloaded = false;
  for (const line of String(reason || '').split('\n')) {
    const p = line.trim();
    if (!p.startsWith('/')) continue;
    const blob = readFile(p);
    if (!blob) continue;
    const kb = Math.round(Buffer.byteLength(blob, 'utf8') / 1024);
    const handle = `<<fnd-prompt-json full=${p} ~${kb} KB — read it with jq or a targeted Read; never raw-Read a whale>>`;
    for (const part of texts) {
      if (!part.text.includes(blob)) continue;
      part.text = part.text.split(blob).join(handle);
      offloaded = true;
    }
  }
  return offloaded;
}

export const FndPlugin = async (ctx = {}) => {
  const cwd = ctx.directory || ctx.worktree || (ctx.project && ctx.project.worktree) || process.cwd();
  // Sessions that already received the dynamic context. Per plugin instance, so a restart
  // re-injects rather than staying silent on a session it cannot remember.
  const seen = new Set();

  return {
    'chat.message': async (input, output) => {
      const started = hostTrace.start();
      // Set once this turn is one the adapter acts on, so an assistant message — which returns
      // before any of it runs — writes no line at all.
      let traced = null;
      try {
        const parts = (output && output.parts) || (input && input.parts);
        const message = (output && output.message) || (input && input.message) || {};
        if (message.role && message.role !== 'user') return;
        traced = 'pass';

        // Read before anything is injected: what the prompt hooks measure has to be what the
        // developer actually wrote, or a session-context block could tip a prompt over the
        // JSON guard's size gate.
        const prompt = textParts(parts).map((p) => p.text).join('\n');

        const sessionID = message.sessionID || (input && input.sessionID) || '';
        if (!seen.has(sessionID)) {
          // Marked before the injection can fail, so a message without a text part does not
          // arm the block for every later message in the session.
          if (seen.size > 500) seen.clear();
          seen.add(sessionID);
          const context = dynamicSessionContext(cwd);
          // Its own line, under the event every other host spells SessionStart: this injection
          // IS this host's session start, and the matrix has to be able to see it fire.
          if (context && injectContext(parts, context)) {
            hostTrace.trace({ event: 'SessionStart', hook: 'fnd-plugin', decision: 'inject', startedAt: started });
          }
        }

        // Same short-circuit as the Claude Code wiring: with both halves off no node spawns.
        if (process.env.FND_CTX_MONITOR === '0' && process.env.FND_PROMPT_JSON === '0') return;
        if (!prompt) return;

        const event = JSON.stringify({
          hook_event_name: 'UserPromptSubmit',
          prompt,
          cwd,
          session_id: sessionID,
        });
        const r = await runScript(NODE_BIN, [path.join(HOOKS, 'user-prompt.cjs')], event, PROMPT_TIMEOUT_MS);
        const decision = parseHookOutput(r.stdout);
        if (!decision) return;

        if (decision.decision === 'block' && decision.reason) {
          // The deny is user-prompt.cjs's own verdict and its own trace line; the adapter only
          // carried it out, so this turn's adapter line stays `pass`.
          offloadSpilledBlobs(parts, decision.reason);
          return; // the reason is written for a prompt that got erased — it must not reach the model
        }
        const extra = decision.hookSpecificOutput && decision.hookSpecificOutput.additionalContext;
        if (typeof extra === 'string' && extra && injectContext(parts, extra)) traced = 'inject';
      } catch (_) {
        // Injection is never worth losing a message over.
      } finally {
        if (traced) {
          hostTrace.trace({ event: 'UserPromptSubmit', hook: 'fnd-plugin', decision: traced, startedAt: started });
        }
      }
    },

    'tool.execute.before': async (input, output) => {
      const tool = (input && input.tool) || (output && output.tool);
      const args = (output && output.args) || (input && input.args) || {};
      if (tool === 'read' || tool === 'grep') {
        await recordSpillAccess(tool === 'read' ? 'Read' : 'Grep', args, cwd);
        return;
      }
      if (tool !== 'bash') return;
      const command = args.command;
      if (typeof command !== 'string' || !command) return;

      const event = JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command },
        cwd,
      });
      // Same order as the Claude Code manifest, and no try/catch around the loop: a thrown
      // block is the whole point of this hook and must never be swallowed into an allow.
      for (const guard of ['no-ai-attribution.sh', 'no-verify-bypass.sh']) {
        const r = await runScript('bash', [path.join(HOOKS, guard)], event, GUARD_TIMEOUT_MS);
        if (r.code === 2) throw new Error(r.stderr.trim() || `Blocked by the fnd ${guard} guard.`);
        if (r.code === 0) continue;
        // No verdict: a spawn error, a timeout, a guard that is not in the bundle any more. The
        // attribution guard fails open; the no-verify guard fails CLOSED on exactly the commands
        // it would have inspected, because a missing commit guard is a broken install.
        const why = r.error ? r.error.code || r.error.message : `exit ${r.code}`;
        warn(`${guard} reached no verdict (${why})`);
        if (guard === 'no-verify-bypass.sh' && GIT_TRIGGER.test(command)) {
          throw new Error(
            `The fnd commit guard (hooks/no-verify-bypass.sh) could not run (${why}), so this git command is ` +
              'blocked rather than run unchecked. Re-install / repair the fnd plugin, then re-run the same ' +
              'command. Never bypass the repo git hooks (--no-verify, core.hooksPath, HUSKY=0) — they are ' +
              'quality gates.'
          );
        }
      }
      // After the guards, never before: a blocked command was not run, so it read no spill.
      await recordSpillAccess('Bash', args, cwd);
    },

    'tool.execute.after': async (input, output) => {
      // The bail-outs below leave a line too: with no line at all, the host proof cannot tell an
      // MCP result this adapter skipped from a hook the host never called.
      const started = hostTrace.start();
      let tool = null;
      try {
        if (process.env.FND_MCP_SLIM === '0') return;
        tool = (input && input.tool) || (output && output.tool);
        if (!isMcpTool(tool)) return;
        // Two shapes reach this hook (measured on 1.18.21): a built-in tool's `{title, output,
        // metadata}` with the text in `output`, and an MCP tool's RAW result `{content:[…],
        // isError}` — the Claude Code shape mcp-slim reads natively, rewritten block by block.
        const text = output && output.output;
        const rawMcp = output && Array.isArray(output.content) ? output : null;
        const textShape = typeof text === 'string' && text.length > 0;
        if (!textShape && !rawMcp) {
          hostTrace.trace({ event: 'PostToolUse', hook: 'fnd-plugin', decision: 'skip', tool: claudeToolName(tool), startedAt: started });
          return;
        }

        // The size gate, the error rails and the whole spill-and-stub decision live in
        // mcp-slim; duplicating any of them here would fork the contract for one host.
        const event = JSON.stringify({
          hook_event_name: 'PostToolUse',
          tool_name: claudeToolName(tool),
          tool_response: textShape ? text : rawMcp,
          cwd,
        });
        const r = await runScript(NODE_BIN, [path.join(HOOKS, 'mcp-slim.cjs')], event, SLIM_TIMEOUT_MS);
        // A spawn that never ran leaves no child line — this one stands in for it.
        if (r.error) hostTrace.trace({ event: 'PostToolUse', hook: 'fnd-plugin', decision: 'error', tool: claudeToolName(tool), startedAt: started });
        const emitted = parseHookOutput(r.stdout);
        const slimmed = emitted && emitted.hookSpecificOutput && emitted.hookSpecificOutput.updatedToolOutput;
        // Each shape comes back as itself; anything else means the shapes stopped matching, and a
        // serialized object in place of tool text is worse than the whale.
        if (textShape) {
          if (typeof slimmed === 'string' && slimmed.length < text.length) output.output = slimmed;
        } else if (slimmed && Array.isArray(slimmed.content)
          && JSON.stringify(slimmed.content).length < JSON.stringify(rawMcp.content).length) {
          output.content = slimmed.content;
        }
      } catch (_) {
        // Compression is an optimization — the original result always survives a failure.
        if (tool) hostTrace.trace({ event: 'PostToolUse', hook: 'fnd-plugin', decision: 'error', tool: claudeToolName(tool), startedAt: started });
      }
    },

    event: async (payload = {}) => {
      try {
        const event = payload.event || payload;
        if (!event || event.type !== 'session.deleted') return;
        const props = event.properties || {};
        const id = props.sessionID || (props.info && props.info.id) || props.id;
        if (id) seen.delete(id);
      } catch (_) {}
    },
  };
};
