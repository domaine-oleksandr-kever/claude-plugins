#!/usr/bin/env node
// PreToolUse hook (matcher: the browser MCP tools that take a file path) — keep QA scratch out of
// the working tree, and every path inside the project the servers will accept. A screenshot tool
// writes wherever its path argument points, and for the servers installed per-user that argument
// resolves inside the checkout, so `filename: "elc-123-cart.jpeg"` lands 78 stray binaries in a
// theme repo (live evidence, elc-theme 2026-08).
// references/task-workspace.md already forbids it in prose; this is the mechanical half.
//
// Contract (Claude Code):
//   in  — PreToolUse event JSON on stdin: {tool_name, tool_input:{…}, cwd}. The candidate paths
//         are `tool_input.filePath` (chrome-devtools take_screenshot / take_snapshot),
//         `requestFilePath` / `responseFilePath` (chrome-devtools get_network_request) and
//         `filename` (playwright browser_take_screenshot, and browser_run_code_unsafe's script —
//         a file the server READS); every one present is judged. `tool_name` decides three things:
//         WHICH DIRECTORY a relative candidate resolves against, whether an in-tree path is litter
//         (a file the tool only reads is not), and the verdict when there is NO path at all
//         (below); the matcher in each host's wiring is the routing.
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
// Deny rule, two halves. A path that resolves OUTSIDE the project root (the host's scratchpad,
// system tmp, another checkout) is DENIED: both servers canonicalize it and refuse any file outside
// their roots, so the deny only saves the failed round-trip and names a path that works. The one
// outside root a server does accept — chrome-devtools' OS temp dir (`os.tmpdir()`) — passes for
// its writing tools. Inside the
// tree the rule is narrow on purpose: DENY only when the path lands outside a first-segment
// `.claude/`. Allowed: anything under `.claude/` (the task workspaces, `.claude/tmp/`, the swept
// playwright output dir), and any in-tree file the tool only reads. An in-project `tmp/` is NOT
// one of the allowed dirs: a theme checkout does not carry one and does not gitignore one, so
// `tmp/shot.png` is exactly where a denied model puts the file on its second attempt — same
// litter, one directory deeper. `.claude` has to be the FIRST segment, too: a path that reaches it
// through litter (`.playwright-mcp/.claude/tmp/x.png`) is still litter. "Project working tree" =
// the session's project dir, the root the screenshot servers run in — NOT always the event's
// `cwd`: the Bash tool's cwd persists, so after a `cd .claude/tasks/<id>/tmp` the event's cwd is
// that directory (see projectRoot).
//
// A git worktree (scripts/worktree-setup.sh) is the one exception to "anything under `.claude/` is
// fine": its `.claude/tasks` is a symlink into the MAIN checkout, and the screenshot servers
// canonicalize a path and refuse whatever lands outside this project — so a candidate that resolves
// into that symlinked dir is DENIED (the server would hard-fail it), and every remediation there
// names `<worktree>/.claude/tmp/<work-id>/` instead of the task workspace.
//
// NO path field is not automatically an allow. chrome-devtools without a path returns the image,
// snapshot or body inline and writes nothing, and browser_run_code_unsafe with inline `code` reads
// no file — allowed. The bundled playwright writes to its
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
// CLAUDE_PROJECT_DIR (set by Claude Code for hooks) — the project root, see projectRoot.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// The tool_input keys the wired tools carry a file path in.
const PATH_KEYS = ['filePath', 'filename', 'requestFilePath', 'responseFilePath'];
// The wired tool whose path is a script the server reads: an in-tree file is no litter.
const READS_FILE = /(^|__)browser_run_code_unsafe$/;
// Playwright's screenshot tool, whatever server prefix a host puts in front of it. It is the one
// wired tool that writes a file even when the model names no path (see the header).
const ALWAYS_WRITES = /(^|__)browser_take_screenshot$/;
// …and the exact name Claude Code gives THIS plugin's own playwright server, the only one whose
// manifest pins `--output-dir`. Anything else is treated as a default-configured server.
const BUNDLED_PLAYWRIGHT = /^mcp__plugin_fnd_playwright__browser_take_screenshot$/;
// Keep in sync with the manifest's `--output-dir` arg and scripts/scratch-hygiene.cjs's
// PLAYWRIGHT_OUT_REL — a hooks-sim case pins the three together.
const PLAYWRIGHT_OUT_REL = '.claude/fnd-tmp/playwright';
const PLAYWRIGHT_OUT_SEGS = PLAYWRIGHT_OUT_REL.split('/');
// Where @playwright/mcp writes with no --output-dir: straight into the checkout.
const PLAYWRIGHT_DEFAULT_OUT = '.playwright-mcp';

// The directory a RELATIVE candidate actually resolves against — the server's output dir for
// playwright's screenshot (it resolves `filename` against its own, not the project), the project
// itself for chrome-devtools (a plain path resolved by the tool's own cwd) and for
// browser_run_code_unsafe (resolved against the workspace root).
function resolveBase(root, kind) {
  if (kind === 'bundled') return path.join(root, PLAYWRIGHT_OUT_REL);
  if (kind === 'playwright') return path.join(root, PLAYWRIGHT_DEFAULT_OUT);
  return root;
}

// The bundled server's scratch dir is allowed BECAUSE it is swept and git-excluded. The sweep half
// rides on the compressor's switches (a developer with FND_MCP_SLIM=0 or FND_MCP_SLIM_TTL=0 still
// gets this allow), and the exclude half costs two git forks a session — so the guard makes that
// half true itself rather than allowing on someone else's promise. The stamp lives in its own small
// module for this caller's sake: it used to be reached through json-slim.cjs, so a PreToolUse guard
// on every screenshot loaded a ~230 KB compressor to call a 34-line function. Still required lazily
// and inside the allow branches only — a deny owes nothing, so it should not pay even ~1 ms.
function markExcluded(root) {
  try { require('../scripts/scratch-hygiene.cjs').ensureFndTmpExcluded(root); } catch (_) {} // fail-open, like everything here
}

function outside(rel) {
  return rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel);
}

function within(base, p) {
  const rel = path.relative(base, p);
  return rel === '' || !outside(rel);
}

// The `.claude` subdirs a model `cd`s into; the project is the dir above that `.claude`.
const SCRATCH_SUBDIRS = new Set(['tasks', 'tmp', 'fnd-tmp']);

// The session's project dir. Claude Code exports it to hooks as CLAUDE_PROJECT_DIR, and it is the
// only rail that survives the PHYSICAL cwd Claude Code persists — from a worktree's symlinked
// `.claude/tasks` that cwd sits in the MAIN checkout — so it wins whenever the cwd is inside it,
// lexically, physically, or through that link, and always under Claude Code's own wiring
// (FND_HOST=claude sets it per hook): a Bash `cd` into a scratchpad must not move the root the
// outside-the-project deny measures against. Elsewhere it may be inherited from another session,
// so otherwise (Codex, Cursor): the cwd, cut back above a
// `.claude/{tasks,tmp,fnd-tmp}` segment. Never the git toplevel: a session opened in a monorepo
// subdir keeps its `.claude` there.
function projectRoot(cwd) {
  const abs = path.resolve(cwd);
  const env = String(process.env.CLAUDE_PROJECT_DIR || '').trim();
  if (path.isAbsolute(env)) {
    if (process.env.FND_HOST === 'claude') return env;
    const cwdReal = real(abs);
    const viaLink = within(real(path.join(env, '.claude', 'tasks')), cwdReal);
    if (within(env, abs) || within(real(env), cwdReal) || viaLink) return env;
  }
  const segs = abs.split(path.sep);
  for (let i = 1; i < segs.length; i++) {
    if (segs[i] === '.claude' && (i === segs.length - 1 || SCRATCH_SUBDIRS.has(segs[i + 1]))) {
      return segs.slice(0, i).join(path.sep) || path.sep;
    }
  }
  return abs;
}

// The realpath of `<root>/.claude/tasks` when it points OUTSIDE the checkout (a worktree's shared
// workspace), else null.
function linkedTasks(root) {
  const tasks = real(path.join(root, '.claude', 'tasks'));
  return outside(path.relative(real(root), tasks)) ? tasks : null;
}

// Where to send the write instead. Absolute, because the playwright server resolves a relative
// filename against its output dir; and inside the workspace, because it rejects anything outside
// its allowed roots. `workId` is only known when the denied path itself named one. `optOut` false
// drops the FND_SCRATCH_GUARD hint: past a deny the server refuses that write anyway.
function whereInstead(root, name, linked, workId, optOut = true) {
  const hint = optOut ? `\n\n(To allow project scratch anyway, set FND_SCRATCH_GUARD=0.)` : '';
  if (linked) {
    return (
      `Write it to ${path.join(root, '.claude/tmp', workId || '<work-id>', name)}` +
      (workId ? '' : ` (the work-id of the ticket you are on), or ${path.join(root, '.claude/tmp', name)} when there is no ticket`) +
      `. This checkout is a git worktree: its task workspace is a symlink into the main checkout, ` +
      `and the screenshot servers resolve the link and refuse any file outside this project. Give ` +
      `the tool the ABSOLUTE path — the playwright server resolves a relative filename against its ` +
      `own output dir, not the project.` +
      hint
    );
  }
  return (
    `Write it to the task workspace instead: ${path.join(root, '.claude/tasks/<work-id>/tmp', name)} ` +
    `(the work-id dir of the ticket you are on), or ${path.join(root, '.claude/tmp', name)} when ` +
    `there is no ticket. Give the tool the ABSOLUTE path — the playwright server resolves a ` +
    `relative filename against its own output dir, not the project — and keep it inside the ` +
    `project, which the screenshot servers require, and outside every diff.` +
    hint
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
function ensureScratchDirs(root, linked, workId) {
  const claude = path.join(root, '.claude');
  const targets = [path.join(claude, 'tmp')];
  if (linked) {
    if (workId) targets.push(path.join(claude, 'tmp', workId));
  } else {
    try {
      for (const e of fs.readdirSync(path.join(claude, 'tasks'), { withFileTypes: true })) {
        if (e.isDirectory()) targets.push(path.join(claude, 'tasks', e.name, 'tmp'));
      }
    } catch (_) {} // no task workspaces yet → the no-ticket answer is the only one to prepare
  }
  for (const t of targets) {
    try {
      fs.mkdirSync(t, { recursive: true });
    } catch (_) {}
  }
}

function deny(reason, root, linked, workId) {
  ensureScratchDirs(root, linked, workId);
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

  const candidates = PATH_KEYS.map((k) => ti[k]).filter((v) => typeof v === 'string' && v.trim() !== '');

  const root = projectRoot(typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd());
  const linked = linkedTasks(root);
  const tool = typeof input.tool_name === 'string' ? input.tool_name : '';
  // The one classification both halves of the rule read: which base a relative candidate resolves
  // against, and what a call with no path at all means.
  const kind = BUNDLED_PLAYWRIGHT.test(tool) ? 'bundled' : ALWAYS_WRITES.test(tool) ? 'playwright' : 'other';

  if (candidates.length === 0) {
    // chrome-devtools without a path writes nothing (the result comes back inline), and the
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
        whereInstead(root, '<name>.png', linked),
      root,
      linked
    );
  }

  for (const candidate of candidates) {
    const decision = pathDecision(candidate, root, linked, kind, READS_FILE.test(tool));
    if (decision) return decision;
  }
  return null;
}

function pathDecision(candidate, root, linked, kind, readsOnly) {
  const resolved = path.resolve(resolveBase(root, kind), candidate);
  const resolvedReal = real(resolved);
  if (linked) {
    const inTasks = path.relative(linked, resolvedReal);
    if (inTasks !== '' && !outside(inTasks)) {
      const segs = inTasks.split(path.sep);
      const workId = segs.length > 1 ? segs[0] : undefined;
      return deny(
        `fnd scratch-path guard: that path resolves into the task workspace, where the ` +
          `screenshot server would refuse the file.\n\n` +
          whereInstead(root, path.basename(resolved), linked, workId, false),
        root,
        linked,
        workId
      );
    }
  }
  const rel = path.relative(real(root), resolvedReal);
  // An empty rel means the path IS the project dir, which no file can be written to anyway.
  if (rel === '') return null;
  if (outside(rel)) {
    // chrome-devtools-mcp always adds the OS temp dir to its roots; playwright never does.
    if (kind === 'other' && !readsOnly && within(real(os.tmpdir()), resolvedReal)) return null;
    return deny(
      `fnd scratch-path guard: "${candidate}" resolves to ${resolved}, outside this project ` +
        `(${root}). The screenshot and browser servers accept only files inside this project ` +
        `(chrome-devtools also its OS temp dir), ` +
        `so the call would fail with an access-denied error.\n\n` +
        whereInstead(root, path.basename(resolved), linked, undefined, false),
      root,
      linked
    );
  }
  if (readsOnly) return null;

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
      whereInstead(root, path.basename(resolved), linked),
    root,
    linked
  );
}

module.exports = { scratchPathDecision };

if (require.main === module) {
  try { require('../scripts/env-file.cjs').load(); } catch (_) {} // domaine env files fill process.env gaps; absent in a partial install
  // FND_HOST_TRACE, the host-proof log. Stubbed on require failure — a partial install must not
  // cost the guard.
  let hostTrace = { trace() {}, enabled() { return false; }, start() { return 0; } };
  try { hostTrace = require('./host-trace.cjs'); } catch (_) {}

  const chunks = [];
  process.stdin.on('data', (d) => chunks.push(d));
  process.stdin.on('end', () => {
    const t = hostTrace.start();
    let verdict = 'pass';
    let tool;
    try {
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (input && typeof input.tool_name === 'string') tool = input.tool_name;
      const decision = scratchPathDecision(input);
      if (decision) {
        process.stdout.write(JSON.stringify(decision));
        verdict = 'deny';
      }
    } catch (_) {
      // Any failure → emit nothing, the tool call proceeds (fail-open).
      verdict = 'error';
    }
    // After the verdict is on stdout: bookkeeping never delays the tool call.
    hostTrace.trace({ event: 'PreToolUse', hook: 'scratch-path-guard', decision: verdict, tool, startedAt: t });
  });
}
