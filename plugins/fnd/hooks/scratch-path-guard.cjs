#!/usr/bin/env node
// PreToolUse hook (matcher: the two browser screenshot tools) — keep QA scratch out of the
// working tree. A screenshot tool writes wherever its path argument points, and for the servers
// installed per-user that argument resolves inside the checkout, so `filename: "elc-123-cart.jpeg"`
// lands 78 stray binaries in a theme repo (live evidence, elc-theme 2026-08).
// references/task-workspace.md already forbids it in prose; this is the mechanical half.
//
// Contract (Claude Code):
//   in  — PreToolUse event JSON on stdin: {tool_name, tool_input:{…}, cwd}. The candidate path
//         is `tool_input.filePath` (chrome-devtools take_screenshot) or `tool_input.filename`
//         (playwright browser_take_screenshot). `tool_name` decides two things: WHICH DIRECTORY a
//         relative candidate resolves against, and the verdict when there is NO path at all (below);
//         the matcher in each host's wiring is the routing.
//   out — a deny is `hookSpecificOutput:{hookEventName:"PreToolUse", permissionDecision:"deny",
//         permissionDecisionReason:<text>}` on stdout, exit 0; the reason reaches the MODEL, so
//         it names where to write instead. Print nothing → the call proceeds.
//
// The BUNDLED playwright server is not the same server as a per-user one, and the difference is
// the whole rule. @playwright/mcp resolves a relative `filename` against its OWN output dir, not
// the project — and writes its no-filename artefacts (page-<ts>.png, .yml snapshot dumps, console
// logs) there too. This plugin's manifest pins that dir to `.claude/fnd-tmp/playwright`, which the
// mcp-slim TTL sweep prunes and `.git/info/exclude` hides, so for the bundled server a bare
// filename and a missing filename are both already scratch. Any OTHER spelling of the tool — a
// per-user `claude mcp add playwright`, Codex's and Cursor's unprefixed names — may be a server
// running with the default `<cwd>/.playwright-mcp`, and is judged as one.
// That allow is bought with the sweep: a file in that dir EXPIRES on FND_MCP_SLIM_TTL (24 h), so
// anything meant to be kept — QA evidence, the screenshots a steps-to-test doc points at — still
// belongs in `<project>/.claude/tasks/<work-id>/tmp/`, which nothing prunes.
//
// Deny rule — narrow on purpose. DENY only when the resolved path lands inside the project working
// tree AND outside a first-segment `.claude/`. Everything else is allowed: anything under
// `.claude/` (the task workspaces, `.claude/tmp/`, the swept playwright output dir), and any
// absolute path outside the tree (system tmp, a scratchpad). An in-project `tmp/` is NOT one of
// the allowed dirs: a theme checkout does not carry one and does not gitignore one, so
// `tmp/shot.png` is exactly where a denied model puts the file on its second attempt — same
// litter, one directory deeper. `.claude` has to be the FIRST segment, too: a path that reaches it
// through litter (`.playwright-mcp/.claude/tmp/x.png`) is still litter. "Project working tree" =
// the event's `cwd` — the session's project dir.
//
// NO path field is not automatically an allow. chrome-devtools' take_screenshot without `filePath`
// returns the image inline and writes nothing — allowed. The bundled playwright writes to its
// pinned output dir — allowed. A per-user playwright writes to `<cwd>/.playwright-mcp`, inside the
// checkout (live evidence: 374 untracked files, 29 MB, not gitignored) — denied, with the
// remediation below.
//
// The remediation paths are ABSOLUTE, and that is load-bearing: a relative one handed to the
// playwright server resolves against its output dir, so `.claude/tmp/x.png` would land NESTED
// inside it instead of where the reason says. They still stay inside the project tree, because the
// server refuses any file outside its allowed roots (its output dir and its cwd) — "write it to
// system tmp" would turn a deny into a hard tool error.
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
// …and the exact name Claude Code gives THIS plugin's own playwright server, the only one whose
// manifest pins `--output-dir`. Anything else is treated as a default-configured server.
const BUNDLED_PLAYWRIGHT = /^mcp__plugin_fnd_playwright__browser_take_screenshot$/;
// Keep in sync with the manifest's `--output-dir` arg and json-slim.cjs's PLAYWRIGHT_OUT_REL — a
// hooks-sim case pins the three together.
const PLAYWRIGHT_OUT_REL = '.claude/fnd-tmp/playwright';
const PLAYWRIGHT_OUT_SEGS = PLAYWRIGHT_OUT_REL.split('/');
// Where @playwright/mcp writes with no --output-dir: straight into the checkout.
const PLAYWRIGHT_DEFAULT_OUT = '.playwright-mcp';

// The directory a RELATIVE candidate actually resolves against — the server's output dir for
// playwright (it resolves `filename` against its own, not the project), the project itself for
// chrome-devtools (its `filePath` is a plain path resolved by the tool's own cwd).
function resolveBase(root, kind) {
  if (kind === 'bundled') return path.join(root, PLAYWRIGHT_OUT_REL);
  if (kind === 'playwright') return path.join(root, PLAYWRIGHT_DEFAULT_OUT);
  return root;
}

// The bundled server's scratch dir is allowed BECAUSE it is swept and git-excluded. The sweep half
// rides on the compressor's switches (a developer with FND_MCP_SLIM=0 or FND_MCP_SLIM_TTL=0 still
// gets this allow), and the exclude half costs two git forks a session — so the guard makes that
// half true itself rather than allowing on someone else's promise. Required lazily and inside the
// allow branches only: no deny, and no other server, ever loads the compressor for this.
function markExcluded(root) {
  try { require('../scripts/json-slim.cjs').ensureFndTmpExcluded(root); } catch (_) {} // fail-open, like everything here
}

// Where to send the write instead. Absolute, because the playwright server resolves a relative
// filename against its output dir; and inside the workspace, because it rejects anything outside
// its allowed roots.
function whereInstead(root, name) {
  return (
    `Write it to the task workspace instead: ${path.join(root, '.claude/tasks/<work-id>/tmp', name)} ` +
    `(the work-id dir of the ticket you are on), or ${path.join(root, '.claude/tmp', name)} when ` +
    `there is no ticket. Give the tool the ABSOLUTE path — the playwright server resolves a ` +
    `relative filename against its own output dir, not the project — and keep it inside the ` +
    `project, which the screenshot servers require, and outside every diff.\n\n` +
    `(To allow project scratch anyway, set FND_SCRATCH_GUARD=0.)`
  );
}

// The recommended directories have to EXIST before the model retries. Neither remediation path is
// created by anyone else: chrome-devtools' write path resolves the file and writes it straight out
// (no mkdir — @playwright/mcp does mkdir -p its dirname, but the deny reason serves both tools),
// and `.claude/tmp/` is made by no tool in the bundle — so a deny whose reason names a missing dir
// turns the retry into an ENOENT tool error, and the model goes back to writing in the checkout.
// Creating them is this guard's ONLY side effect and may never take it down: every failure
// (read-only tree, permissions, a `.claude` file in the way) is swallowed and the deny is emitted
// regardless.
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
// the lexical compare answer "outside the tree" for a path that lands right in it. Nothing on the
// candidate side is guaranteed to exist — the leaf file never does, and neither does the server's
// output dir until it first writes — so the walk climbs to the deepest ancestor that DOES resolve
// and re-appends the rest. Canonicalizing only what exists keeps it fail-open: an unresolvable
// path comes back as the string it arrived as.
function real(p) {
  const tail = [];
  let cur = p;
  for (;;) {
    try {
      return tail.length ? path.join(fs.realpathSync(cur), ...tail) : fs.realpathSync(cur);
    } catch (_) {}
    const parent = path.dirname(cur);
    if (parent === cur) return p; // reached the root without resolving anything
    tail.unshift(path.basename(cur));
    cur = parent;
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
  // The one classification both halves of the rule read: which base a relative candidate resolves
  // against, and what a call with no path at all means.
  const kind = BUNDLED_PLAYWRIGHT.test(tool) ? 'bundled' : ALWAYS_WRITES.test(tool) ? 'playwright' : 'other';

  if (candidate === null) {
    // chrome-devtools without filePath writes nothing (the image comes back inline), and the
    // bundled playwright's fallback name lands in its pinned, swept output dir — both allowed.
    if (kind !== 'playwright') {
      if (kind === 'bundled') markExcluded(root); // this allow is the one that owes git the stamp
      return null;
    }
    return deny(
      `fnd scratch-path guard: browser_take_screenshot with no "filename" does not skip the ` +
        `write — the server saves it under its own output dir, and this playwright server is not ` +
        `the plugin's own (which pins one), so that dir is ${path.join(root, PLAYWRIGHT_DEFAULT_OUT)}, ` +
        `i.e. inside the project working tree. That directory is untracked litter in every later ` +
        `diff and PR.\n\n` +
        whereInstead(root, '<name>.png'),
      root
    );
  }

  const resolved = path.resolve(resolveBase(root, kind), candidate);
  const rel = path.relative(real(root), real(resolved));
  // Outside the working tree (`..`, another drive) → not our business. An empty rel means the
  // path IS the project dir, which no screenshot can be written to anyway.
  if (rel === '' || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return null;

  // Only the DIRECTORY segments decide — a file merely named `.claude` is still litter. And only
  // the FIRST one: `.playwright-mcp/.claude/tmp/x.png` reaches `.claude` through the very litter
  // this guard exists to stop. A `tmp` segment counts for nothing on its own: it is allowed under
  // `.claude/` and nowhere else.
  const dirs = rel.split(path.sep).slice(0, -1);
  if (dirs[0] === '.claude') {
    // Only the bundled server's own pinned dir earns the stamp — a task-workspace path is the
    // developer's to track, and the exclude covers the whole scratch root either way.
    if (kind === 'bundled' && PLAYWRIGHT_OUT_SEGS.every((s, i) => dirs[i] === s)) markExcluded(root);
    return null;
  }

  return deny(
    (kind === 'playwright'
      // For a per-user playwright the output dir is INFERRED, not supplied — the server may have been
      // given its own --output-dir this guard cannot see, so the reason states the assumption it read.
      ? `fnd scratch-path guard: "${candidate}" resolves, for a playwright server running with no ` +
        `--output-dir, into ${resolved} — inside the project working tree. QA screenshots and other `
      : `fnd scratch-path guard: "${candidate}" would write into the project working tree ` +
        `(${resolved}). QA screenshots and other `) +
      `scratch never live in a checkout — they show up ` +
      `as untracked litter in every later diff and PR.\n\n` +
      whereInstead(root, path.basename(resolved)),
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
