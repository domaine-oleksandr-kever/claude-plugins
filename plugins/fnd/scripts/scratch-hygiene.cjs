/*
 * scratch-hygiene.cjs — PROJECT-side scratch hygiene for the bundled @playwright/mcp server's
 * output dir (`<project>/.claude/fnd-tmp/playwright`): the age-based sweep of the artefacts it
 * drops there, and the `.git/info/exclude` stamp that keeps the whole scratch root out of
 * `git status`. Both live here rather than in the compressor because neither compresses anything.
 *
 * Two callers:
 *   hooks/scratch-path-guard.cjs → ensureFndTmpExcluded — the stamp its allow of that scratch dir
 *     is bought with. A PreToolUse guard on every screenshot, so it must not load a compressor.
 *   scripts/json-slim.cjs        → sweepPlaywrightOut, from sweepSpills' throttled project pass.
 *
 * Reads NO environment switch: the TTL cutoff is computed by the caller and handed in, so this
 * module adds no new reader of FND_MCP_SLIM_TTL (json-slim.cjs's spillTtlHours parses it;
 * hooks/mcp-slim.cjs re-checks it as a pre-gate before loading json-slim at all).
 * Node built-ins only (repo policy): fs, path, and child_process required lazily inside
 * ensureFndTmpExcluded so no caller pays for it until a stamp is actually owed.
 */
'use strict';

const fs = require('fs');
const path = require('path');

// The bundled @playwright/mcp server's `--output-dir`, PROJECT-relative: the server resolves it against
// its own cwd, which every host launches in the project dir. The same literal is spelled in the manifest's
// args and in hooks/scratch-path-guard.cjs; a hooks-sim case pins the three together. Without it the
// server defaults to `<cwd>/.playwright-mcp`, where every no-`filename` screenshot, `.yml` snapshot dump
// and console log lands — 374 untracked files in one client checkout, gitignored by nobody. Pointing it
// under `.claude/` puts that traffic in a directory this sweep prunes and git never sees.
const PLAYWRIGHT_OUT_REL = '.claude/fnd-tmp/playwright';
// The `.git/info/exclude` pattern that keeps the whole scratch root out of `git status` (and out of a
// bulk `git add`). The written line is anchored (leading slash) and trailing-slashed: a directory,
// never a stray match — and anchoring is at the REPO root, so the line is built with the project's
// path prefix inside the repo rather than used as-is (see ensureFndTmpExcluded).
const EXCLUDE_SUFFIX = '.claude/fnd-tmp/';

// Second sweep target: `<project>/.claude/fnd-tmp/playwright`, where the bundled server drops the
// artefacts no tool call names a path for (page-<ts>.png, the .yml snapshot dumps, console-<ts>.log,
// session/trace files). Same TTL and the same total silence as the spill pass — the browser session's
// own files are only ever re-read within the run that made them. Directories are left standing:
// playwright nests per-session dirs, and an empty one costs nothing while removing it could race a
// live session. Absent dir = playwright never ran in this project, the common case, so this is one
// stat on the throttled path.
function sweepPlaywrightOut(projectDir, cutoff, summary) {
  // Every component of the path has to be a REAL directory, checked with lstat: the walk below deletes
  // by mtime alone, with no name filter, so a single symlinked component would aim it at whatever the
  // link points at and prune that instead. Not hypothetical — this plugin's own worktree flow symlinks
  // `<wt>/.claude/tasks` at the main checkout, so a part-symlinked `.claude` subtree is a live shape.
  // (Nested entries are already lstat-based: readdir Dirents do not follow links.)
  let dir = projectDir;
  for (const seg of PLAYWRIGHT_OUT_REL.split('/')) {
    dir = path.join(dir, seg);
    try {
      if (!fs.lstatSync(dir).isDirectory()) return;
    } catch (_) { return; }
  }
  const walk = (d, depth) => {
    if (depth > 8) return; // a pathological nest is not worth unbounded recursion
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      try {
        if (e.isDirectory()) { walk(p, depth + 1); continue; }
        if (!e.isFile()) continue; // symlinks and sockets are not ours to delete
        if (fs.statSync(p).mtimeMs < cutoff) { fs.unlinkSync(p); summary.swept++; }
      } catch (_) {} // gone / racing / unreadable → skip
    }
  };
  walk(dir, 0);
  ensureFndTmpExcluded(projectDir);
}

// Keep the scratch root invisible to git without editing anything the developer owns: `.gitignore` is
// a tracked file of the client's repo, `.git/info/exclude` is local-only. Best-effort and silent —
// this rides on a sweep, and a sweep may never influence a hook's output or exit code. Two callers:
// the sweep, at most once per throttle window and only in a project playwright has written in, and
// hooks/scratch-path-guard.cjs, whose allow of the bundled server's scratch dir is justified by this
// stamp — so the guard makes it true itself rather than waiting on a compressor switch.
function ensureFndTmpExcluded(projectDir) {
  try {
    const { spawnSync } = require('child_process'); // required here so the hot path never loads it
    const opts = { cwd: projectDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 };
    // 0 = git already ignores it (a repo-level rule, or a stamp from an earlier run); 1 = not ignored;
    // anything else (128, a spawn failure) = no repo / no git, where there is nothing to exclude from.
    const ci = spawnSync('git', ['check-ignore', '-q', '.claude/fnd-tmp'], opts);
    if (ci.status !== 1) return;
    // An anchored pattern is read from the REPO root, but the session's project dir may sit deeper in it
    // (`cd packages/theme && claude`) — there `/.claude/fnd-tmp/` would match nothing, and the "already
    // stamped" scan below would then block the correct line forever. The prefix git reports for this dir
    // is what puts the anchor in the right place; it already ends in `/` when non-empty.
    const sp = spawnSync('git', ['rev-parse', '--show-prefix'], opts);
    if (sp.status !== 0 || typeof sp.stdout !== 'string') return;
    const line = `/${sp.stdout.trim()}${EXCLUDE_SUFFIX}`;
    // --git-path answers with the COMMON dir's file, so one stamp serves every worktree of the repo —
    // the same rule scripts/worktree-setup.sh follows for `.claude/tasks`.
    const gp = spawnSync('git', ['rev-parse', '--git-path', 'info/exclude'], opts);
    if (gp.status !== 0 || typeof gp.stdout !== 'string') return;
    const rel = gp.stdout.trim();
    if (!rel) return;
    const file = path.isAbsolute(rel) ? rel : path.join(projectDir, rel);
    let body = '';
    try { body = fs.readFileSync(file, 'utf8'); } catch (_) {} // no exclude file yet → create it below
    const has = body.split('\n').some((l) => l.trim() === line);
    if (has) return;
    // An exclude file whose last byte is not a newline is legal and not rare; appending blind would glue
    // our pattern onto the developer's last one, breaking both.
    const bridge = body !== '' && !body.endsWith('\n') ? '\n' : '';
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch (_) {}
    fs.appendFileSync(file, `${bridge}${line}\n`);
  } catch (_) {} // any failure → the dir stays visible in git status, which is not worth a broken hook
}

// EXCLUDE_SUFFIX stays private — nothing outside builds that line itself.
module.exports = { sweepPlaywrightOut, ensureFndTmpExcluded, PLAYWRIGHT_OUT_REL };
