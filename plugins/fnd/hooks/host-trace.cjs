// FND_HOST_TRACE — the host-proof log, Node half. Required by the .cjs hooks (user-prompt,
// scratch-path-guard, mcp-slim, codex-mcp-shim) and by the OpenCode adapter.
//
// Why it exists: "did this hook actually fire on this host?" could only ever be answered by a
// model reporting on itself. One JSONL line per invocation, appended by the hook itself, answers
// it from disk instead — `doctor.cjs --trace` reads the file back as an event × host matrix.
//
//   file    <spill root>/fnd-host-trace.log, spill root = FND_MCP_SLIM_DIR else os.tmpdir();
//           rotated ONCE to fnd-host-trace.log.1 at 5 MB, like fnd-mcp-slim-debug.log.
//   record  {"ts","host","event","hook","decision","tool","agent","project","ms"} — that key
//           order, a key whose value is unknown or empty omitted. METADATA ONLY: never a
//           payload, never command text, never prompt text, never the path of a spill.
//
// THE RULE: tracing may never change a hook's stdout, its stderr semantics or its exit code.
// Every failure is swallowed and nothing is ever printed.
//
// The tolerant require, because a partial install must never break a hook:
//   let hostTrace = { trace() {}, enabled() { return false; }, start() { return 0; } };
//   try { hostTrace = require('./host-trace.cjs'); } catch (_) {}
//   const t = hostTrace.start();
//   hostTrace.trace({ event: 'PostToolUse', hook: 'mcp-slim', decision: 'compress',
//                     tool: name, startedAt: t });
//
// The switch is GLOBAL-ONLY — the process env, else the global Domaine env file. Callers have
// already run scripts/env-file.cjs load(); this module retries it in a try/catch so a caller
// that did not still sees the global file, and env-file's default-deny keeps the switch out of
// the project layer a client repo can commit.
//
// Deliberately tiny and dependency-light: mcp-slim's below-gate fast path traces WITHOUT loading
// the ~210 KB json-slim module, so the `.git` walk below is reimplemented here rather than
// imported from it.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const LOG = 'fnd-host-trace.log';
const LOG_MAX = 5 * 1024 * 1024; // json-slim's DEBUG_LOG_MAX — one file, one rotation
const HOSTS = new Set(['claude', 'cursor', 'codex', 'opencode']);
const PROJECT_WALK_MAX = 64;
// Insertion order IS the record's key order; `ts` and `host` are written first, `project` and
// `ms` last, so only the middle needs a list.
const FIELDS = ['event', 'hook', 'decision', 'tool', 'agent'];

let switchState = null;
function enabled() {
  if (switchState !== null) return switchState;
  switchState = false;
  try {
    let raw = process.env.FND_HOST_TRACE;
    if (raw === undefined || raw === '') { // an empty value is "unset" here as in the sh half
      try { require('../scripts/env-file.cjs').load(); } catch (_) {} // partial install → env only
      raw = process.env.FND_HOST_TRACE;
    }
    switchState = /^(1|true|yes|on)$/i.test(String(raw === undefined ? '' : raw).trim());
  } catch (_) {}
  return switchState;
}

// Token for the `ms` field. Wall clock, not hrtime: the number is read by a human next to an
// ISO timestamp, and a sub-millisecond hook is reported as 0 either way.
function start() {
  return Date.now();
}

let projectMemo;
function projectName() {
  if (projectMemo !== undefined) return projectMemo;
  projectMemo = null;
  try {
    const from = process.cwd();
    let d = path.resolve(from);
    let root = '';
    for (let i = 0; i < PROJECT_WALK_MAX; i++) {
      if (fs.existsSync(path.join(d, '.git'))) { root = d; break; }
      const up = path.dirname(d);
      if (up === d) break; // filesystem root — no repo above the cwd
      d = up;
    }
    projectMemo = path.basename(path.resolve(root || from)) || null;
  } catch (_) {} // any failure → omit the field
  return projectMemo;
}

function trace(fields) {
  try {
    if (!enabled()) return;
    const f = fields || {};
    // An absent or unrecognized FND_HOST is `unknown` on purpose — the matrix's column set is a
    // closed vocabulary, not whatever the environment holds.
    const raw = String(process.env.FND_HOST || '');
    const rec = { ts: new Date().toISOString(), host: HOSTS.has(raw) ? raw : 'unknown' };
    for (const k of FIELDS) {
      const v = f[k] === undefined || f[k] === null ? '' : String(f[k]);
      if (v) rec[k] = v;
    }
    const project = projectName();
    if (project) rec.project = project;
    let ms = f.ms;
    if (ms === undefined && typeof f.startedAt === 'number') ms = Date.now() - f.startedAt;
    if (typeof ms === 'number' && Number.isFinite(ms)) rec.ms = Math.max(0, Math.round(ms));
    // 0700 for the reason writeSpill gives: whichever writer CREATES the shared root decides the
    // mode for everything that lands in it afterwards.
    const root = process.env.FND_MCP_SLIM_DIR || os.tmpdir();
    try { fs.mkdirSync(root, { recursive: true, mode: 0o700 }); } catch (_) {}
    const logPath = path.join(root, LOG);
    try {
      if (fs.statSync(logPath).size >= LOG_MAX) fs.renameSync(logPath, path.join(root, `${LOG}.1`));
    } catch (_) {} // no log yet, or the rotate failed → just append below
    fs.appendFileSync(logPath, `${JSON.stringify(rec)}\n`, { mode: 0o600 });
  } catch (_) {}
}

module.exports = { trace, enabled, start, LOG, LOG_MAX };
