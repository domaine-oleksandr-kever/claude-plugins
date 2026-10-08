#!/usr/bin/env node
/*
 * scratch-hygiene.cjs — project-side hygiene for base's scratch root `.claude/base-tmp`: the
 * age-based sweep of the files in it (the bundled playwright server's output dir among them), and
 * the `.git/info/exclude` stamp that keeps it out of `git status` and out of a bulk `git add`.
 *
 * Callers:
 *   hooks/scratch-path-guard.cjs → ensureCoreTmpExcluded, the stamp its allow of the bundled
 *     playwright server's output dir is bought with.
 *   hooks/mods/doctor.ts → the CLI, once per session:
 *     node scratch-hygiene.cjs --sweep <project> [--ttl-hours N]
 *       → `swept=<n> kept=<n>` on stdout; exit 0 always (a sweep never fails a session), 2 on bad usage.
 *   scripts/doctor.cjs → baseTmpStats, the base-tmp row.
 * `--ttl-hours` is BASE_TMP_TTL as the mod read it (default 24; 0 sweeps nothing). Node built-ins
 * only; child_process is required lazily, so a caller pays for it only when a stamp is owed.
 */
'use strict';

const fs = require('fs');
const path = require('path');

// The bundled @playwright/mcp server's `--output-dir`, PROJECT-relative: the server resolves it against
// its own cwd, the project dir. The same literal is spelled in the manifest's args and in
// hooks/scratch-path-guard.cjs; tests/base-guards-sim.sh pins the three together.
const PLAYWRIGHT_OUT_REL = '.claude/base-tmp/playwright';
// The stamped line is anchored (leading slash) and trailing-slashed: a directory, never a stray match.
const SCRATCH_ROOT_REL = '.claude/base-tmp';
const DEFAULT_TTL_HOURS = 24;
const MAX_DEPTH = 8;

// Keep the scratch root invisible to git without editing anything the developer owns: `.gitignore` is
// a tracked file of the repo, `.git/info/exclude` is local-only. Best-effort and silent: a failure
// leaves the dir visible in git status, never a broken hook.
function ensureCoreTmpExcluded(projectDir) {
  try {
    const { spawnSync } = require('child_process');
    const opts = { cwd: projectDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 };
    // 0 = git already ignores it; 1 = not ignored; anything else = no repo / no git.
    const ci = spawnSync('git', ['check-ignore', '-q', SCRATCH_ROOT_REL], opts);
    if (ci.status !== 1) return;
    // A pattern with an interior slash is read from the REPO root, and the project dir may sit deeper
    // in it (`cd packages/web && claude`): the prefix git reports puts the anchor in the right place.
    const sp = spawnSync('git', ['rev-parse', '--show-prefix'], opts);
    if (sp.status !== 0 || typeof sp.stdout !== 'string') return;
    const line = `/${sp.stdout.trim()}${SCRATCH_ROOT_REL}/`;
    // --git-path answers with the COMMON dir's file, so one stamp serves every worktree of the repo.
    const gp = spawnSync('git', ['rev-parse', '--git-path', 'info/exclude'], opts);
    if (gp.status !== 0 || typeof gp.stdout !== 'string') return;
    const excl = gp.stdout.trim();
    if (!excl) return;
    const file = path.isAbsolute(excl) ? excl : path.join(projectDir, excl);
    let body = '';
    try { body = fs.readFileSync(file, 'utf8'); } catch (_) {}
    if (body.split('\n').some((l) => l.trim() === line)) return;
    // An exclude file whose last byte is not a newline is legal; appending blind would glue two patterns.
    const bridge = body !== '' && !body.endsWith('\n') ? '\n' : '';
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch (_) {}
    fs.appendFileSync(file, `${bridge}${line}\n`);
  } catch (_) {}
}

/**
 * `<project>/.claude/base-tmp` when every component of it is a REAL directory, else null. The sweep
 * deletes by mtime alone, with no name filter, so one symlinked component would aim it at whatever
 * the link points at — and the worktree flow symlinks `<wt>/.claude/tasks`, so a part-symlinked
 * `.claude` subtree is a live shape.
 */
function scratchRoot(projectDir) {
  let dir = projectDir;
  for (const seg of SCRATCH_ROOT_REL.split('/')) {
    dir = path.join(dir, seg);
    try {
      if (!fs.lstatSync(dir).isDirectory()) return null;
    } catch (_) {
      return null;
    }
  }
  return dir;
}

/** Visits every regular file under the scratch root (symlinks are never followed nor counted). */
function walkFiles(dir, visit, depth = 0) {
  if (depth > MAX_DEPTH) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    try {
      if (e.isDirectory()) walkFiles(p, visit, depth + 1);
      else if (e.isFile()) visit(p, fs.statSync(p));
    } catch (_) {}
  }
}

/**
 * Deletes the scratch root's files older than `ttlHours`. Directories stay standing: playwright nests
 * per-session dirs, and removing one could race a live session. Absent root = nothing ever ran here.
 */
function sweepCoreTmp(projectDir, ttlHours, now = Date.now()) {
  const summary = { swept: 0, kept: 0 };
  const root = scratchRoot(projectDir);
  if (!root) return summary;
  if (ttlHours > 0) {
    const cutoff = now - ttlHours * 3_600_000;
    walkFiles(root, (p, st) => {
      if (st.mtimeMs < cutoff) {
        try { fs.unlinkSync(p); summary.swept++; return; } catch (_) {}
      }
      summary.kept++;
    });
  } else {
    walkFiles(root, () => { summary.kept++; });
  }
  ensureCoreTmpExcluded(projectDir);
  return summary;
}

/** What the doctor reports: present or not, the file count, the bytes, and how many are past `ttlHours`. */
function baseTmpStats(projectDir, ttlHours, now = Date.now()) {
  const root = scratchRoot(projectDir);
  const stats = { present: !!root, files: 0, bytes: 0, stale: 0 };
  if (!root) return stats;
  const cutoff = ttlHours > 0 ? now - ttlHours * 3_600_000 : -Infinity;
  walkFiles(root, (_p, st) => {
    stats.files++;
    stats.bytes += st.size;
    if (st.mtimeMs < cutoff) stats.stale++;
  });
  return stats;
}

/** BASE_TMP_TTL as hours: a non-negative number, else the default. */
function parseTtl(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return DEFAULT_TTL_HOURS;
  const n = Number(String(raw).trim());
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_TTL_HOURS;
}

const USAGE = 'usage: scratch-hygiene.cjs --sweep <project-dir> [--ttl-hours <n>]\n';

function main(argv) {
  let project = null;
  let ttl;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      process.stdout.write(USAGE);
      return 0;
    }
    if (a === '--sweep' || a === '--ttl-hours') {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) {
        process.stderr.write(`scratch-hygiene: ${a} needs a value\n${USAGE}`);
        return 2;
      }
      if (a === '--sweep') project = v;
      else ttl = v;
      continue;
    }
    process.stderr.write(`scratch-hygiene: unknown argument ${a}\n${USAGE}`);
    return 2;
  }
  if (!project) {
    process.stderr.write(USAGE);
    return 2;
  }
  const s = sweepCoreTmp(path.resolve(project), parseTtl(ttl));
  process.stdout.write(`swept=${s.swept} kept=${s.kept}\n`);
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = {
  ensureCoreTmpExcluded,
  sweepCoreTmp,
  baseTmpStats,
  parseTtl,
  PLAYWRIGHT_OUT_REL,
  SCRATCH_ROOT_REL,
  DEFAULT_TTL_HOURS,
};
