#!/usr/bin/env node
// PreToolUse hook (matcher: the two browser screenshot tools) — keep QA scratch out of the
// working tree. A screenshot tool writes wherever the model's relative path says, and the
// model's cwd IS the project root, so `filename: "elc-123-cart.jpeg"` lands 78 stray binaries
// in a theme checkout (live evidence, elc-theme 2026-08). references/task-workspace.md already
// forbids it in prose; this is the mechanical half.
//
// Contract (Claude Code):
//   in  — PreToolUse event JSON on stdin: {tool_name, tool_input:{…}, cwd}. The candidate path
//         is `tool_input.filePath` (chrome-devtools take_screenshot) or `tool_input.filename`
//         (playwright browser_take_screenshot). `tool_name` is read for ONE decision only (the
//         no-path case below); the matcher in each host's wiring is the routing.
//   out — a deny is `hookSpecificOutput:{hookEventName:"PreToolUse", permissionDecision:"deny",
//         permissionDecisionReason:<text>}` on stdout, exit 0; the reason reaches the MODEL, so
//         it names where to write instead. Print nothing → the call proceeds.
//
// Deny rule — narrow on purpose. DENY only when the resolved path lands inside the project
// working tree AND outside `.claude/`. Everything else is allowed: anything under `.claude/`
// (the task workspaces and `.claude/tmp/`), and any absolute path outside the tree (system tmp,
// a scratchpad). An in-project `tmp/` is NOT one of the allowed dirs: a theme checkout does not
// carry one and does not gitignore one, so `tmp/shot.png` is exactly where a denied model puts
// the file on its second attempt — same litter, one directory deeper. "Project working tree" =
// the event's `cwd` — the session's project dir, which is what the model's relative paths
// resolve against.
//
// NO path field is not automatically an allow. chrome-devtools' take_screenshot without
// `filePath` returns the image inline and writes nothing — allowed. Playwright's
// browser_take_screenshot ALWAYS writes: with no `filename` the bundled server falls back to
// `<outputDir>/page-<ts>.png`, and with no `--output-dir` in mcp.json that outputDir is
// `<cwd>/.playwright-mcp` — inside the checkout (live evidence: 367 untracked files in
// elc-theme/.playwright-mcp, not gitignored). So that one is denied too, with the same
// remediation. Both remediation paths stay INSIDE the workspace on purpose: the playwright
// server refuses any file outside its allowed roots (`<cwd>/.playwright-mcp` and `<cwd>`), so
// "write it to system tmp" would turn a deny into a hard tool error.
//
// Fail-open on ANY internal error (unparsable stdin, fs/permission failure, a bug here): a
// guard that misfires must never block QA. Same rail as every other hook in this bundle.
//
// Env: FND_SCRATCH_GUARD — 0 disables the guard (each host's wiring short-circuits on it too,
// so node does not even spawn; re-checked here for a direct invocation).
'use strict';

const fs = require('fs');
const path = require('path');

// The tool_input keys the two wired screenshot tools use for their output path, in probe order.
const PATH_KEYS = ['filePath', 'filename'];
// Playwright's screenshot tool, whatever server prefix a host puts in front of it. It is the one
// wired tool that writes a file even when the model names no path (see the header).
const ALWAYS_WRITES = /(^|__)browser_take_screenshot$/;

// Where to send the write instead. Both stay inside the workspace: the playwright server rejects
// anything outside its allowed roots, so an out-of-tree suggestion would break the retry.
function whereInstead(name) {
  return (
    `Write it to the task workspace instead: .claude/tasks/<work-id>/tmp/${name} (the work-id ` +
    `dir of the ticket you are on), or .claude/tmp/${name} when there is no ticket. Both are ` +
    `inside the workspace, which the screenshot servers require, and outside every diff.\n\n` +
    `(To allow project scratch anyway, set FND_SCRATCH_GUARD=0.)`
  );
}

// The recommended directories have to EXIST before the model retries. Neither remediation path
// is created by anyone else: @playwright/mcp's `filename` branch resolves the path and writes it
// straight out (no mkdir), and `.claude/tmp/` is made by no tool in the bundle — so a deny whose
// reason names a missing dir turns the retry into an ENOENT tool error, and the model goes back
// to writing in the checkout. Creating them is this guard's ONLY side effect and may never take
// it down: every failure (read-only tree, permissions, a `.claude` file in the way) is swallowed
// and the deny is emitted regardless.
function ensureScratchDirs(root) {
  const claude = path.join(root, '.claude');
  const targets = [path.join(claude, 'tmp')];
  try {
    for (const e of fs.readdirSync(path.join(claude, 'tasks'), { withFileTypes: true })) {
      if (e.isDirectory()) targets.push(path.join(claude, 'tasks', e.name, 'tmp'));
    }
  } catch (_) {} // no task workspaces yet → the no-ticket answer is the only one to prepare
  for (const t of targets) {
    try {
      fs.mkdirSync(t, { recursive: true });
    } catch (_) {}
  }
}

function deny(reason, root) {
  ensureScratchDirs(root);
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}

// realpath both sides before comparing: a symlinked prefix (/tmp → /private/tmp on macOS) makes
// the lexical compare answer "outside the tree" for a path that lands right in it. Fail-open —
// an unresolvable path (the file does not exist yet, which is the NORMAL case for the leaf) keeps
// the string it came with, so only existing prefixes are canonicalized.
function real(p) {
  try {
    return fs.realpathSync(p);
  } catch (_) {
    try {
      return path.join(fs.realpathSync(path.dirname(p)), path.basename(p));
    } catch (_e) {
      return p;
    }
  }
}

// One PreToolUse deny decision for `input`, or null when the call proceeds untouched.
function scratchPathDecision(input) {
  if (process.env.FND_SCRATCH_GUARD === '0') return null; // belt-and-suspenders vs the wiring gate
  const ti = input && input.tool_input;
  if (!ti || typeof ti !== 'object') return null;

  let candidate = null;
  for (const key of PATH_KEYS) {
    const v = ti[key];
    if (typeof v === 'string' && v.trim() !== '') {
      candidate = v;
      break;
    }
  }

  const root = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
  const tool = typeof input.tool_name === 'string' ? input.tool_name : '';

  if (candidate === null) {
    // chrome-devtools without filePath writes nothing (the image comes back inline) — allow.
    if (!ALWAYS_WRITES.test(tool)) return null;
    return deny(
      `fnd scratch-path guard: browser_take_screenshot with no "filename" does not skip the ` +
        `write — the server saves it under its own output dir, which with this configuration is ` +
        `${path.join(root, '.playwright-mcp')}, i.e. inside the project working tree. That ` +
        `directory is untracked litter in every later diff and PR.\n\n` +
        whereInstead('<name>.png'),
      root
    );
  }

  const resolved = path.resolve(root, candidate);
  const rel = path.relative(real(root), real(resolved));
  // Outside the working tree (`..`, another drive) → not our business. An empty rel means the
  // path IS the project dir, which no screenshot can be written to anyway.
  if (rel === '' || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return null;

  // Only the DIRECTORY segments decide — a file merely named `.claude` is still litter. A `tmp`
  // segment counts for nothing on its own: it is allowed under `.claude/` and nowhere else.
  const dirs = rel.split(path.sep).slice(0, -1);
  if (dirs.includes('.claude')) return null;

  return deny(
    `fnd scratch-path guard: "${candidate}" would write into the project working tree ` +
      `(${resolved}). QA screenshots and other scratch never live in a checkout — they show up ` +
      `as untracked litter in every later diff and PR.\n\n` +
      whereInstead(path.basename(resolved)),
    root
  );
}

module.exports = { scratchPathDecision };

if (require.main === module) {
  try { require('../scripts/env-file.cjs').load(); } catch (_) {} // domaine env files fill process.env gaps; absent in a partial install

  const chunks = [];
  process.stdin.on('data', (d) => chunks.push(d));
  process.stdin.on('end', () => {
    try {
      const decision = scratchPathDecision(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      if (decision) process.stdout.write(JSON.stringify(decision));
    } catch (_) {
      // Any failure → emit nothing, the tool call proceeds (fail-open).
    }
  });
}
