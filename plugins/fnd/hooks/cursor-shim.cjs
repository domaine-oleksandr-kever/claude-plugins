#!/usr/bin/env node
// Cursor hook adapter (M5). Cursor speaks its own hook dialect — snake_case payload keys,
// its own event names, response keys `additional_context` / `permission` /
// `updated_mcp_tool_output` — while every line of guard, injection and compression logic
// lives in hooks/*.cjs|sh in the Claude Code protocol and stays SINGLE-COPY. This file is
// the whole divergence: translate the event in, spawn the canonical script unchanged,
// translate its stdout/exit code back out.
//
//   usage: node cursor-shim.cjs <cursorEventName>   (event also read from the payload's
//          `hook_event_name`, so a wiring that omits the argument still works)
//   in   — Cursor hook payload JSON on stdin.
//   out  — one Cursor response object on stdout, or nothing (= "leave it alone").
//
// Event map (wiring: hooks/hooks-cursor.json):
//   sessionStart          → the DYNAMIC session context only. The static conventions
//                           (comment-discipline, lean-code, task-workspace, mcp-whale,
//                           untrusted-content, plugin-feedback) ship as always-applied
//                           rules/*.mdc on Cursor
//                           (M4), so injecting them here too would duplicate every one of
//                           them in context. What a rule file cannot do is look at the
//                           workspace: the plugin-root line (store-access.md resolves its
//                           script paths against it) and the store-access convention
//                           itself, gated on the same store-file detection the Claude Code
//                           wiring does.
//   beforeSubmitPrompt    → hooks/user-prompt.cjs (context monitor + large-JSON guard).
//   subagentStart         → hooks/subagent-conventions.sh.
//   beforeShellExecution  → hooks/no-ai-attribution.sh + hooks/no-verify-bypass.sh, then
//                           hooks/spill-access.sh (measurement only, status ignored). Cursor
//                           documents no read-file event, so a spill this host's file reader
//                           opens is not recorded — shell reads are the whole coverage here.
//   afterMCPExecution     → observe-only. Cursor's event has NO response schema
//                           (cursor.com/docs/agent/hooks; measured 2026.09.02: every rewrite key
//                           is ignored, the model reads the raw result), so mcp-slim is never
//                           spawned here — the shim only logs that the hook fired.
//   beforeMCPExecution    → hooks/scratch-path-guard.cjs, the PreToolUse screenshot-path deny
//                           (M3). Cursor documents this event (cursor.com/docs/agent/hooks) with
//                           the same allow/deny/ask primitive as beforeShellExecution. Two
//                           payload divergences it handles: `tool_input` arrives as a JSON
//                           STRING, and the tool name carries no server prefix
//                           (`mcp_server_name` is its own field), so the tool filter this event
//                           needs (Cursor has no per-event matcher) matches the bare spelling
//                           too.
//
// Fail-open everywhere: a crash, an unparsable payload, a script that cannot be spawned,
// an unknown event → emit nothing, exit 0, the host proceeds untouched. The ONE exception
// is the commit guard: `no-verify-bypass.sh` exiting 2 becomes `permission: "deny"` (plus
// exit 2, Cursor's documented Claude-compatible deny signal), and a no-verify guard that
// could not reach a verdict at all on a git command denies rather than waving it through —
// a guard that cannot run is a broken install, not a verdict (see runGuards).
//
// Paths resolve from `__dirname`, never from CURSOR_PLUGIN_ROOT / CLAUDE_PLUGIN_ROOT:
// Cursor sets both for plugin hooks and has a staff-acknowledged leak bug between
// concurrent plugins' hook processes, so the env vars are a cross-check that warns on
// stderr and nothing else — and every spawned script inherits the root this file resolved,
// not the leaked one (runScript).
//
// Wiring notes (hooks/hooks-cursor.json holds no comments of its own): each command mirrors
// the plugin.json gate for that event so a disabled half spawns no node at all, and ends in
// `|| true` so a broken bundle can never surface as a hook error — with ONE exception,
// beforeShellExecution, where `|| true` would swallow the exit-2 deny signal.
// Each command also PROBES for this file instead of trusting the plugin-root env: it walks
// CURSOR_PLUGIN_ROOT → CLAUDE_PLUGIN_ROOT → ~/.cursor/plugins/local/fnd (the documented install
// path) and takes the first that actually holds `hooks/cursor-shim.cjs`, so the same leak the
// shim defends against cannot make the guard event resolve to a MODULE_NOT_FOUND exit 1 —
// which Cursor reads as "not a deny" and runs the command. The workspace cwd is deliberately
// NOT a candidate: a checkout could then hand the hook a script of its own to run. The runtime
// is probed on the same footing (`command -v node`): a shim that is present but cannot be RUN
// exits 127 with empty stdout, which Cursor reads as "not a deny" exactly like the missing-file
// case, so both fall into the SAME fallback. When either probe fails, the guard command denies
// (exit 2 + the JSON body) any payload whose raw text names a git verb and stays silent
// otherwise — the shim's own no-verdict rule below, read bluntly: shell has no JSON parser (and
// without node there is nothing to emit one), and while the guard cannot run, over-blocking git
// work is the safe side of the trade.
//
// Env: reads no switch of its own. FND_CTX_MONITOR / FND_PROMPT_JSON / FND_MCP_SLIM are
// re-checked here so a shim invoked directly gates like the wiring does (hooks-cursor.json
// short-circuits first, so a disabled half spawns no node at all). FND_SPILL_ACCESS is checked
// HERE only: its hook rides inside beforeShellExecution, whose wiring must stay ungated because
// the commit guard shares the event; FND_LEAN is honored by
// subagent-conventions.sh, but NOT at sessionStart on this host — the lean-code convention
// arrives as rules/fnd-lean-code.mdc there (README "Environment switches"). It WRITES one:
// FND_HOST=cursor, for itself and for every script it spawns, which is the `host` column of the
// FND_HOST_TRACE log.
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// domaine env files fill process.env gaps (env > project > global); the spawned canonical
// hooks inherit the result, and sessionStart forwards `applied` so Cursor propagates the
// file-sourced values to every later hook in the session — including the shell fast-gates.
// Absent in a partial install — the shim must keep guarding without it.
let DOMAINE_ENV = { applied: {}, files: {} };
try { DOMAINE_ENV = require('../scripts/env-file.cjs').load(); } catch (_) {}

// FND_HOST_TRACE, the host-proof log. Set on this process rather than by the wiring: the trace
// helper reads the host out of the env, and hooks-cursor.json's commands are shared with the
// no-node fallback that must stay a pure-shell deny. Assigning it here also carries `cursor` to
// every spawned canonical script through the inherited env (runScript pins it explicitly too).
process.env.FND_HOST = 'cursor';
let hostTrace = { trace() {}, enabled() { return false; }, start() { return 0; } };
try { hostTrace = require('./host-trace.cjs'); } catch (_) {} // partial install → no tracing, no crash
// This host composes sessionStart / beforeSubmitPrompt / subagentStart HERE (the other events
// only translate a spawned script's verdict, and that script writes its own line), so these three
// are traced under the canonical event names the matrix's rows are keyed by.
const TRACED_EVENTS = {
  sessionStart: 'SessionStart',
  beforeSubmitPrompt: 'UserPromptSubmit',
  subagentStart: 'SubagentStart',
};

const HOOKS_DIR = __dirname;
const PLUGIN_ROOT = path.resolve(__dirname, '..');

// A hung guard would hang the IDE's shell approval, so every spawn is bounded. Generous on
// purpose: mcp-slim carries its own wall-clock budget (FND_MCP_SLIM_BUDGET_MS) and this is
// only the outer ceiling for whatever that budget cannot interrupt.
const SPAWN_TIMEOUT_MS = 30000;
// A whale MCP result is the reason this exists: the default 1 MB spawn buffer would truncate
// mcp-slim's stdout mid-JSON, which parses as "no compression" and drops the spill handle.
const SPAWN_MAX_BUFFER = 256 * 1024 * 1024;

function warn(msg) {
  try {
    process.stderr.write(`fnd cursor-shim: ${msg}\n`);
  } catch (_) {} // a closed stderr must not take the hook down
}

// The env vars are informational — say so loudly when they disagree with where this file
// actually sits, because that divergence IS the leak bug and the only cheap way to spot it.
function crossCheckRoot() {
  for (const name of ['CURSOR_PLUGIN_ROOT', 'CLAUDE_PLUGIN_ROOT']) {
    const v = process.env[name];
    if (!v) continue;
    let resolved;
    try {
      resolved = fs.realpathSync(v);
    } catch (_) {
      resolved = path.resolve(v);
    }
    let own = PLUGIN_ROOT;
    try {
      own = fs.realpathSync(PLUGIN_ROOT);
    } catch (_) {}
    if (resolved !== own) warn(`${name}=${v} does not match this bundle (${own}) — using the bundle`);
  }
}

// Run one canonical hook script with Claude-protocol JSON on stdin. SPAWNED, not required:
// user-prompt.cjs and mcp-slim.cjs are entry points that read stdin and print a decision, and
// requiring them would mean either editing them to export their entry (the one thing this
// port may not do) or re-implementing it here — for the price of one extra node startup
// (~18 ms) on an event the wiring already gates. `.cjs` scripts go through THIS node
// (process.execPath) so the shim and the scripts can never disagree about the runtime;
// `.sh` scripts run their own shebang, falling back to bash when the exec bit was lost
// (a `--copy` install on a filesystem without one).
//
// The child's plugin-root env is OVERWRITTEN with this bundle's own root: `__dirname` protects
// the shim, but not a spawned script that prefers the env (subagent-conventions.sh does), and
// under Cursor's leak bug that script would read another plugin's bundle, find no convention
// files, and exit 0 with empty stdout — a silent no-injection nobody can see. Passing the root
// we resolved keeps the single-copy scripts unedited and makes the env agree with reality.
function runScript(name, stdin) {
  const file = path.join(HOOKS_DIR, name);
  const opts = {
    input: stdin,
    timeout: SPAWN_TIMEOUT_MS,
    maxBuffer: SPAWN_MAX_BUFFER,
    encoding: 'utf8',
    env: {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
      CURSOR_PLUGIN_ROOT: PLUGIN_ROOT,
      FND_HOST: 'cursor', // the child writes its own trace line, and only this shim knows the host
    },
  };
  let r = name.endsWith('.cjs') ? spawnSync(process.execPath, [file], opts) : spawnSync(file, [], opts);
  if (r.error && !name.endsWith('.cjs') && ['EACCES', 'ENOEXEC', 'EPERM'].includes(r.error.code)) {
    r = spawnSync('bash', [file], opts);
  }
  return {
    status: typeof r.status === 'number' ? r.status : null,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    error: r.error || null,
  };
}

function readFileOr(p, fallback) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch (_) {
    return fallback; // a missing convention file drops that block, never the whole injection
  }
}

// Cursor reports the open folders as `workspace_roots`; the store detection below needs the
// same directory the Claude Code wiring reads with `[ -f shopify.theme.toml ]`, i.e. where
// the session actually runs.
function workspaceRoot(payload) {
  const roots = payload.workspace_roots;
  if (Array.isArray(roots) && typeof roots[0] === 'string' && roots[0]) return roots[0];
  for (const k of ['workspace_root', 'cwd', 'project_root']) {
    if (typeof payload[k] === 'string' && payload[k]) return payload[k];
  }
  return process.cwd();
}

function firstDefined(payload, keys) {
  for (const k of keys) if (payload[k] !== undefined) return payload[k];
  return undefined;
}

// ── sessionStart ────────────────────────────────────────────────────────────────────────
function sessionStart(payload) {
  const cwd = workspaceRoot(payload);
  // store-access.md spells its runner paths "relative to the plugin root above", so the
  // root line is part of that block's contract, not a debug echo.
  const parts = [`fnd plugin root: ${PLUGIN_ROOT}`];
  const storeFiles = ['shopify.theme.toml', '.env'];
  if (storeFiles.some((f) => fs.existsSync(path.join(cwd, f)))) {
    const text = readFileOr(path.join(HOOKS_DIR, 'store-access.md'), '');
    if (text) parts.push(text);
  }
  const out = { additional_context: parts.join('\n') };
  if (Object.keys(DOMAINE_ENV.applied).length) out.env = DOMAINE_ENV.applied;
  return out;
}

// ── beforeSubmitPrompt ──────────────────────────────────────────────────────────────────
function beforeSubmitPrompt(payload) {
  if (process.env.FND_CTX_MONITOR === '0' && process.env.FND_PROMPT_JSON === '0') return null;
  const prompt = firstDefined(payload, ['prompt', 'text', 'message']);
  if (typeof prompt !== 'string') return null;

  // UserPromptSubmit shape. `transcript_path` has no Cursor equivalent — the context monitor
  // returns nothing without one, which degrades to "no context notice on this host" while the
  // large-JSON guard (prompt + cwd only) works exactly as it does on Claude Code.
  const r = runScript(
    'user-prompt.cjs',
    JSON.stringify({
      hook_event_name: 'UserPromptSubmit',
      prompt,
      cwd: workspaceRoot(payload),
      session_id: payload.conversation_id || payload.generation_id || null,
    })
  );
  const decision = parseJson(r.stdout);
  if (!decision) return null;

  // A guard block ERASES the prompt: `reason` is developer-facing (it names the files the
  // pasted JSON was spilled to, which the developer has to re-reference), so it rides
  // userMessage, never the model's context.
  if (decision.decision === 'block') {
    return { continue: false, userMessage: String(decision.reason || '') };
  }
  const out = {};
  const extra = decision.hookSpecificOutput && decision.hookSpecificOutput.additionalContext;
  if (extra) out.additional_context = String(extra);
  if (decision.systemMessage) out.userMessage = String(decision.systemMessage);
  return Object.keys(out).length ? out : null;
}

// ── subagentStart ───────────────────────────────────────────────────────────────────────
function subagentStart(payload) {
  // subagent-conventions.sh skips the read-only agents by `agent_type`; Cursor's spelling of
  // that field is not pinned yet (M1a), so every plausible one is accepted and an unknown
  // shape falls through as the empty string — which the script treats as "unknown agent",
  // erring toward injecting the conventions, the cheap direction.
  let agentType = firstDefined(payload, ['agent_type', 'subagent_type', 'agent_name', 'agent']);
  if (agentType && typeof agentType === 'object') agentType = agentType.name || agentType.type || '';
  const r = runScript('subagent-conventions.sh', JSON.stringify({ agent_type: String(agentType || '') }));
  const text = r.stdout.trim();
  return text ? { additional_context: r.stdout } : null;
}

// ── beforeShellExecution ────────────────────────────────────────────────────────────────
// The guard's own fast-reject words: a command naming none of them can never be a bypass,
// so it is also the command a broken guard is safe to let through (see the no-verdict branch
// in beforeShellExecution below).
// SINGLE SOURCE: hooks/no-verify-bypass.sh — its `case "$input" in *git*|…` line is the list this
// mirrors; opencode/fnd-plugin.js holds the byte-identical twin (both sims diff the two literals),
// and hooks-cursor.json's `case` glob is a deliberately coarser third copy for the no-node path.
const GIT_TRIGGER = /(^|[^a-z])(git|commit|push|merge|pull)|(^|\s)am(\s|$)/i;

// The reason rides BOTH channels on purpose: the JSON body is Cursor's own deny protocol, and
// stderr is what the Claude Code-compatible exit-2 path treats as the model-facing reason. A
// model blocked without a reason retries with another bypass spelling, which is the loop
// no-verify-bypass.sh exists to end.
//
// BOTH key spellings, on every event: Cursor's docs show camelCase for the shell event and
// snake_case for the MCP one, and the host reads at most one of each pair — a set of keys it
// ignores costs nothing, while guessing wrong drops the reason and leaves a silent block.
function denyBody(message) {
  return {
    permission: 'deny',
    userMessage: message,
    agentMessage: message,
    user_message: message,
    agent_message: message,
  };
}

function deny(message) {
  warn(message);
  return { ...denyBody(message), __exit: 2 };
}

function beforeShellExecution(payload) {
  let command = firstDefined(payload, ['command', 'shell_command', 'script']);
  if (command === undefined && payload.tool_input && typeof payload.tool_input === 'object') {
    command = payload.tool_input.command;
  }
  // A payload whose command key this shim does not know is the guard-defeating direction of
  // Cursor's unpinned payload shape (M1a): every command would sail past unchecked. It stays
  // fail-open — denying every shell call on a payload-shape change would brick the IDE — but it
  // says so on stderr, which is the only signal a renamed key is silently disarming the guards.
  if (typeof command !== 'string' || !command) {
    warn('beforeShellExecution payload carries no recognized command key — guards did not run');
    return null;
  }

  const stdin = JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command },
    cwd: workspaceRoot(payload),
  });

  // Same order as the Claude Code wiring, and the same verdict rule: exit 2 blocks and its
  // stderr is the message the model must read.
  for (const guard of ['no-ai-attribution.sh', 'no-verify-bypass.sh']) {
    const r = runScript(guard, stdin);
    if (r.status === 2) {
      return deny(r.stderr.trim() || 'Blocked by the fnd commit guard — re-run the plain git command.');
    }
    if (r.status === 0) continue;
    // No verdict: a spawn error, a timeout, or the script erroring out. Both guards are
    // best-effort by design and a hook failure must never block an ordinary command — but a
    // MISSING commit guard on a git command is a broken install, and letting a `--no-verify`
    // through on the strength of an install defect is the one outcome this layer exists to
    // prevent. So the attribution guard fails open, and the no-verify guard fails CLOSED on
    // exactly the commands it would have inspected.
    const why = r.error ? r.error.code || r.error.message : `exit ${r.status}`;
    warn(`${guard} reached no verdict (${why})`);
    if (guard === 'no-verify-bypass.sh' && GIT_TRIGGER.test(command)) {
      return deny(
        `The fnd commit guard (hooks/no-verify-bypass.sh) could not run (${why}), so this git command is ` +
          'blocked rather than run unchecked. Re-install / repair the fnd plugin, then re-run the same command. ' +
          'Never bypass the repo git hooks (--no-verify, core.hooksPath, HUSKY=0) — they are quality gates.'
      );
    }
  }
  // Measurement only (spill-access.sh records that a tool read an MCP spill, so json-slim --report
  // can pair a whale with the read that recovered it): it never denies, so its status is ignored and
  // it runs only after the guards have let the command through.
  if (process.env.FND_SPILL_ACCESS !== '0') runScript('spill-access.sh', stdin);
  return null;
}

// ── afterMCPExecution ───────────────────────────────────────────────────────────────────
// No rewrite primitive on this host: the docs list no response fields for the event, and
// `updated_mcp_tool_output` / `result_json` / `result` / `tool_response` were all measured as
// ignored (2026.09.02). Spawning mcp-slim would spill whales nobody gets a handle to and stamp
// `compress` on a result the model still reads raw, so the only honest line is `skip`.
function afterMCPExecution(payload) {
  if (process.env.FND_MCP_SLIM === '0') return null;
  const started = hostTrace.start();
  // Cursor's tool name carries no server prefix (`getJiraIssue` + `mcp_server_name`); the log
  // uses the Claude Code spelling so one column reads like the others.
  let tool = firstDefined(payload, ['tool_name', 'tool', 'mcp_tool_name']) || '';
  const server = payload.mcp_server_name;
  if (typeof tool === 'string' && tool && typeof server === 'string' && server && !tool.startsWith('mcp__')) {
    tool = `mcp__${server}__${tool}`;
  }
  hostTrace.trace({ event: 'PostToolUse', hook: 'cursor-shim', decision: 'skip', tool, startedAt: started });
  return null;
}

// ── beforeMCPExecution ──────────────────────────────────────────────────────────────────
// The screenshot scratch-path deny. Cursor runs this for EVERY MCP call — there is no matcher
// in its wiring — so the two tools the guard covers are selected here, on the bare spelling as
// well as the prefixed one (`mcp_server_name` is a separate field on this host).
const SCREENSHOT_TOOL = /(^|__)(take_screenshot|browser_take_screenshot)$/;

function beforeMCPExecution(payload) {
  if (process.env.FND_SCRATCH_GUARD === '0') return null;
  const tool = String(firstDefined(payload, ['tool_name', 'tool', 'mcp_tool_name']) || '');
  if (!SCREENSHOT_TOOL.test(tool)) return null;

  // documented as a JSON string on this host; an object is accepted too rather than betting the
  // guard on one spelling of an unpinned payload
  let ti = firstDefined(payload, ['tool_input', 'tool_args', 'arguments', 'params']);
  if (typeof ti === 'string') ti = parseJson(ti);
  if (!ti || typeof ti !== 'object') ti = {};

  const r = runScript(
    'scratch-path-guard.cjs',
    JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: tool,
      tool_input: ti,
      cwd: workspaceRoot(payload),
    })
  );
  if (r.status !== 0) return null; // a guard that could not run never blocks QA (fail-open)
  const emitted = parseJson(r.stdout);
  const d = emitted && emitted.hookSpecificOutput;
  if (!d || d.permissionDecision !== 'deny') return null;
  // No exit 2 here: the deny primitive on this event is the JSON body alone, unlike the shell
  // event's Claude-compatible exit code.
  const message = String(d.permissionDecisionReason || '');
  warn(message);
  return denyBody(message);
}

const HANDLERS = {
  sessionStart,
  beforeSubmitPrompt,
  subagentStart,
  beforeShellExecution,
  beforeMCPExecution,
  afterMCPExecution,
};

function parseJson(raw) {
  if (!raw || !String(raw).trim()) return null;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function main(raw) {
  const started = hostTrace.start();
  const payload = parseJson(raw) || {};
  const event = process.argv[2] || payload.hook_event_name || '';
  const handler = HANDLERS[event];
  if (!handler) return; // unknown / unwired event → nothing to say
  // Cursor runs hook processes from the PLUGIN dir; the workspace is what the spawned scripts
  // (and their `project` trace field) must see.
  try { process.chdir(workspaceRoot(payload)); } catch (_) {}
  crossCheckRoot();
  const res = handler(payload);
  if (TRACED_EVENTS[event]) {
    hostTrace.trace({
      event: TRACED_EVENTS[event],
      hook: 'cursor-shim',
      decision: res ? 'inject' : 'pass',
      startedAt: started,
    });
  }
  if (!res) return;
  const exit = res.__exit;
  delete res.__exit;
  try {
    process.stdout.write(JSON.stringify(res));
  } catch (_) {} // a host that closed the pipe early (EPIPE) still gets the exit code
  if (exit) process.exitCode = exit;
}

const chunks = [];
// An unhandled 'error' event would exit with a stack trace on stderr and a code the guard
// event reads as "not a deny" anyway — say it quietly instead.
process.stdin.on('error', (e) => warn(`stdin: ${(e && e.code) || e}`));
process.stdin.on('data', (d) => chunks.push(d));
process.stdin.on('end', () => {
  try {
    main(Buffer.concat(chunks).toString('utf8'));
  } catch (e) {
    // Fail-open: the deny paths return before anything here can throw, so whatever went
    // wrong is the shim's problem, not the developer's.
    warn(`unhandled error: ${(e && e.message) || e}`);
  }
});
