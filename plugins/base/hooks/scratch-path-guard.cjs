#!/usr/bin/env node
// The scratch-path verdict for the browser MCP tools that take a file path: keep QA scratch out of
// the working tree, and every path inside the project the servers will accept. A screenshot tool
// writes wherever its path argument points, and for the servers installed per-user that argument
// resolves inside the checkout, so a bare `filename: "abc-123-cart.jpeg"` lands stray binaries in
// the repo. references/task-workspace.md forbids it in prose; this is the mechanical half.
//
// Run by base's hooks module (hooks/mods/guards/scratch.ts) for every tool its GUARDED_RE matches.
//   in  — {tool_name, tool_input:{…}, cwd} on stdin. The candidate paths are `tool_input.filePath`
//         (chrome-devtools take_screenshot / take_snapshot), `requestFilePath` / `responseFilePath`
//         (chrome-devtools get_network_request) and `filename` (playwright browser_take_screenshot,
//         and browser_run_code_unsafe's script — a file the server READS); every one present is
//         judged. `tool_name` decides three things: WHICH DIRECTORY a relative candidate resolves
//         against, whether an in-tree path is litter (a file the tool only reads is not), and the
//         verdict when there is NO path at all (below).
//   out — a deny is `hookSpecificOutput:{hookEventName:"PreToolUse", permissionDecision:"deny",
//         permissionDecisionReason:<text>}` on stdout, exit 0; the reason reaches the MODEL, so
//         it names where to write instead. Print nothing → the call proceeds.
//
// The BUNDLED playwright server is not the same server as a per-user one, and the difference is
// the whole rule. @playwright/mcp resolves a relative `filename` against its OWN output dir, not
// the project — and writes its no-filename artefacts (page-<ts>.png, .yml snapshot dumps, console
// logs) there too. base's manifest pins that dir to `.claude/base-tmp/playwright`, which
// `.git/info/exclude` hides, so for the bundled server a bare filename and a missing filename are
// both already scratch. Any OTHER spelling of the tool — a per-user `claude mcp add playwright` —
// may be a server running with the default `<cwd>/.playwright-mcp`, and is judged as one.
// Anything meant to be kept — QA evidence, the screenshots a steps-to-test doc points at — still
// belongs in `<project>/.claude/tasks/<work-id>/tmp/`, which nothing prunes.
//
// Deny rule, two halves. A path that resolves OUTSIDE the project root (the host's scratchpad,
// system tmp, another checkout) is DENIED: both servers canonicalize it and refuse any file outside
// their roots, so the deny only saves the failed round-trip and names a path that works. The one
// outside root a server does accept — chrome-devtools' OS temp dir (`os.tmpdir()`) — passes for
// its writing tools. Inside the tree the rule is narrow on purpose: DENY only when the path lands
// outside a first-segment `.claude/`. Allowed: anything under `.claude/` (the task workspaces,
// `.claude/tmp/`, the playwright output dir), and any in-tree file the tool only reads. An
// in-project `tmp/` is NOT one of the allowed dirs: a checkout does not carry one and does not
// gitignore one, so `tmp/shot.png` is exactly where a denied model puts the file on its second
// attempt — same litter, one directory deeper. `.claude` has to be the FIRST segment, too: a path
// that reaches it through litter (`.playwright-mcp/.claude/tmp/x.png`) is still litter.
//
// A git worktree (scripts/worktree-setup.sh) is the one exception to "anything under `.claude/` is
// fine": its `.claude/tasks` is a symlink into the MAIN checkout, and the screenshot servers
// canonicalize a path and refuse whatever lands outside this project — so a candidate that resolves
// into that symlinked dir is DENIED (the server would hard-fail it), and every remediation there
// names `<worktree>/.claude/tmp/<work-id>/` instead of the task workspace.
//
// NO path field is not automatically an allow. chrome-devtools without a path returns the image,
// snapshot or body inline and writes nothing, and browser_run_code_unsafe with inline `code` reads
// no file — allowed. The bundled playwright writes to its pinned output dir — allowed. A per-user
// playwright writes to `<cwd>/.playwright-mcp`, inside the checkout — denied, with the remediation
// below.
//
// The remediation paths are ABSOLUTE, and that is load-bearing: a relative one handed to the
// playwright server resolves against its output dir, so `.claude/tmp/x.png` would land NESTED
// inside it instead of where the reason says. They still stay inside the project tree, because the
// server refuses any file outside its allowed roots (its output dir and its cwd).
//
// Fail-open on ANY internal error (unparsable stdin, fs/permission failure, a bug here): a
// guard that misfires must never block QA.
//
// Env: BASE_SCRATCH_GUARD — 0 disables the guard (the mod does not even spawn; re-checked here for
// a direct run). CLAUDE_PROJECT_DIR — the project root: the mod passes the root the session
// launched in, the one the MCP servers run in (see projectRoot).
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// The tool_input keys the guarded tools carry a file path in.
const PATH_KEYS = ['filePath', 'filename', 'requestFilePath', 'responseFilePath'];
// The guarded tool whose path is a script the server reads: an in-tree file is no litter.
const READS_FILE = /(^|__)browser_run_code_unsafe$/;
// Playwright's screenshot tool, whatever server prefix is in front of it. It is the one guarded tool
// that writes a file even when the model names no path (see the header).
const ALWAYS_WRITES = /(^|__)browser_take_screenshot$/;
// …and the exact name Claude Code gives base's own playwright server, the only one whose manifest pins
// `--output-dir`. Anything else is treated as a default-configured server.
const BUNDLED_PLAYWRIGHT = /^mcp__plugin_base_playwright__browser_take_screenshot$/;
// Keep in sync with the manifest's `--output-dir` arg and scripts/scratch-hygiene.cjs's
// PLAYWRIGHT_OUT_REL — tests/base-guards-sim.sh pins the three together.
const PLAYWRIGHT_OUT_REL = '.claude/base-tmp/playwright';
const PLAYWRIGHT_OUT_SEGS = PLAYWRIGHT_OUT_REL.split('/');
// Where @playwright/mcp writes with no --output-dir: straight into the checkout.
const PLAYWRIGHT_DEFAULT_OUT = '.playwright-mcp';

// The directory a RELATIVE candidate actually resolves against — the server's output dir for
// playwright's screenshot (it resolves `filename` against its own, not the project), the project
// itself for chrome-devtools and for browser_run_code_unsafe.
function resolveBase(root, kind) {
  if (kind === 'bundled') return path.join(root, PLAYWRIGHT_OUT_REL);
  if (kind === 'playwright') return path.join(root, PLAYWRIGHT_DEFAULT_OUT);
  return root;
}

// The bundled server's scratch dir is allowed BECAUSE git never sees it, so the allow branches make
// that true themselves. Required lazily, inside the allow branches only: a deny owes nothing.
function markExcluded(root) {
  try { require('../scripts/scratch-hygiene.cjs').ensureCoreTmpExcluded(root); } catch (_) {}
}

function outside(rel) {
  return rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel);
}

function within(base, p) {
  const rel = path.relative(base, p);
  return rel === '' || !outside(rel);
}

// The `.claude` subdirs a model `cd`s into; the project is the dir above that `.claude`.
const SCRATCH_SUBDIRS = new Set(['tasks', 'tmp', 'base-tmp']);

// CLAUDE_PROJECT_DIR when absolute: the mod passes the launch root it latched, and a Bash `cd` (into
// a scratchpad, or through a worktree's symlinked `.claude/tasks` into the main checkout) must not
// move the root the outside-the-project deny measures against. Without it (a direct run): the cwd,
// cut back above a `.claude/{tasks,tmp,base-tmp}` segment. Never the git toplevel: a session opened
// in a monorepo subdir keeps its `.claude` there.
function projectRoot(cwd) {
  const env = String(process.env.CLAUDE_PROJECT_DIR || '').trim();
  if (path.isAbsolute(env)) return env;
  const abs = path.resolve(cwd);
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
// drops the BASE_SCRATCH_GUARD hint: past a deny the server refuses that write anyway.
function whereInstead(root, name, linked, workId, optOut = true) {
  const hint = optOut ? `\n\n(To allow project scratch anyway, set BASE_SCRATCH_GUARD=0.)` : '';
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

// The recommended directories have to EXIST before the model retries: chrome-devtools writes the
// file without a mkdir, and nothing else creates `.claude/tmp/`. Creating them is this guard's ONLY
// side effect and never takes it down: every failure is swallowed and the deny is emitted regardless.
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
    } catch (_) {}
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
// the lexical compare answer "outside the tree" for a path that lands right in it. The leaf never
// exists yet, so the walk climbs to the deepest ancestor that DOES resolve and re-appends the rest;
// an unresolvable path comes back as the string it arrived as.
function real(p) {
  const tail = [];
  let cur = p;
  for (;;) {
    try {
      return tail.length ? path.join(fs.realpathSync(cur), ...tail) : fs.realpathSync(cur);
    } catch (_) {}
    const parent = path.dirname(cur);
    if (parent === cur) return p;
    tail.unshift(path.basename(cur));
    cur = parent;
  }
}

// One PreToolUse deny decision for `input`, or null when the call proceeds untouched.
function scratchPathDecision(input) {
  if (process.env.BASE_SCRATCH_GUARD === '0') return null;
  const ti = input && input.tool_input;
  if (!ti || typeof ti !== 'object') return null;

  const candidates = PATH_KEYS.map((k) => ti[k]).filter((v) => typeof v === 'string' && v.trim() !== '');

  const root = projectRoot(typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd());
  const linked = linkedTasks(root);
  const tool = typeof input.tool_name === 'string' ? input.tool_name : '';
  const kind = BUNDLED_PLAYWRIGHT.test(tool) ? 'bundled' : ALWAYS_WRITES.test(tool) ? 'playwright' : 'other';

  if (candidates.length === 0) {
    // chrome-devtools without a path writes nothing (the result comes back inline), and the
    // bundled playwright's fallback name lands in its pinned output dir — both allowed.
    if (kind !== 'playwright') {
      if (kind === 'bundled') markExcluded(root);
      return null;
    }
    return deny(
      `base scratch-path guard: browser_take_screenshot with no "filename" does not skip the ` +
        `write — the server saves it under its own output dir, and this playwright server is not ` +
        `base's own (which pins one), so that dir is ${path.join(root, PLAYWRIGHT_DEFAULT_OUT)}, ` +
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
        `base scratch-path guard: that path resolves into the task workspace, where the ` +
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
      `base scratch-path guard: "${candidate}" resolves to ${resolved}, outside this project ` +
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
  // this guard exists to stop.
  const dirs = rel.split(path.sep).slice(0, -1);
  if (dirs[0] === '.claude') {
    if (kind === 'bundled' && PLAYWRIGHT_OUT_SEGS.every((s, i) => dirs[i] === s)) markExcluded(root);
    return null;
  }

  return deny(
    (kind === 'playwright'
      // For a per-user playwright the output dir is INFERRED: the reason states the assumption it read.
      ? `base scratch-path guard: "${candidate}" resolves, for a playwright server running with no ` +
        `--output-dir, into ${resolved} — inside the project working tree. QA screenshots and other `
      : `base scratch-path guard: "${candidate}" would write into the project working tree ` +
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
  const chunks = [];
  process.stdin.on('data', (d) => chunks.push(d));
  process.stdin.on('end', () => {
    try {
      const decision = scratchPathDecision(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      if (decision) process.stdout.write(JSON.stringify(decision));
    } catch (_) {}
  });
}
