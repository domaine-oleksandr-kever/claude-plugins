#!/usr/bin/env node
/*
 * bump-version.cjs — one command stamps the plugin version into every packaging file
 * (multi-harness port, M2). The Shopify-AI-Toolkit cautionary tale: version stamps
 * duplicated across per-harness manifests drift unless one script owns all of them.
 *
 *   node bump-version.cjs <new-version|major|minor|patch> [--root <dir>] [--dry-run]
 *
 * Targets and their contracts:
 *   plugins/fnd/.claude-plugin/plugin.json   required, canonical — its `version` is the
 *                                            base for major/minor/patch keyword bumps
 *   plugins/fnd/.cursor-plugin/plugin.json   required
 *   plugins/fnd/.codex-plugin/plugin.json    required
 *   README.md                                required file, optional content: stamps the
 *                                            documented markers `fnd v<semver>` and
 *                                            `FND_VERSION="<semver>"`; a README carrying
 *                                            neither is a reported no-op, not an error
 *   scripts/install.sh                       optional file: stamps every
 *                                            `FND_VERSION="<...>"` assignment it finds
 *
 * JSON manifests are edited surgically (the top-level `"version"` string only) so hand
 * formatting survives. Idempotent: re-stamping the same version writes nothing.
 * Exit codes: 0 done, 1 usage/semver refusal, 2 a target is missing, unparsable or not
 * writable. All-or-nothing by construction: every target is validated (including write
 * permission) before the first write, the new contents are then staged next to each file
 * and renamed into place, and a failure mid-rename restores what was already renamed. A
 * half-stamped repo IS the version drift this script exists to prevent.
 *
 * Pure Node built-ins only (repo policy): fs, path.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const KEYWORDS = ['major', 'minor', 'patch'];

// Documented text markers. Each entry replaces capture group 2 only.
const MARK_ENV = /(FND_VERSION=")([^"\n]*)(")/g;
const MARK_FND_V = /(\bfnd v)(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(\b)/g;

const TARGETS = [
  { rel: 'plugins/fnd/.claude-plugin/plugin.json', kind: 'json', required: true, canonical: true },
  { rel: 'plugins/fnd/.cursor-plugin/plugin.json', kind: 'json', required: true },
  { rel: 'plugins/fnd/.codex-plugin/plugin.json', kind: 'json', required: true },
  { rel: 'README.md', kind: 'text', required: true, marks: [MARK_FND_V, MARK_ENV] },
  { rel: 'scripts/install.sh', kind: 'text', required: false, marks: [MARK_ENV] },
];

const USAGE = [
  'usage: node bump-version.cjs <new-version|major|minor|patch> [--root <dir>] [--dry-run]',
  '',
  '  <new-version>  explicit semver, e.g. 0.60.0',
  '  major|minor|patch  bump the canonical .claude-plugin/plugin.json version',
  '  --root <dir>   repo root to stamp (default: the repo this script ships in)',
  '  --dry-run      report what would change, write nothing',
].join('\n');

function fail(code, message) {
  process.stderr.write(`bump-version: ${message}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const out = { version: null, root: null, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--root') {
      out.root = argv[i + 1];
      if (!out.root) fail(1, `--root needs a directory\n${USAGE}`);
      i += 1;
    } else if (a === '-h' || a === '--help') {
      process.stdout.write(`${USAGE}\n`);
      process.exit(0);
    } else if (a.startsWith('-')) fail(1, `unknown option "${a}"\n${USAGE}`);
    else if (out.version === null) out.version = a;
    else fail(1, `unexpected argument "${a}"\n${USAGE}`);
  }
  if (out.version === null) fail(1, `missing version argument\n${USAGE}`);
  return out;
}

function bumpFrom(current, keyword) {
  if (!SEMVER.test(current)) {
    fail(2, `canonical version "${current}" is not semver — cannot compute a ${keyword} bump`);
  }
  if (/[-+]/.test(current)) {
    fail(
      1,
      `canonical version "${current}" carries a prerelease/build suffix — pass an explicit version instead of "${keyword}"`
    );
  }
  const [major, minor, patch] = current.split('.').map(Number);
  if (keyword === 'major') return `${major + 1}.0.0`;
  if (keyword === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

// Locates the shallowest `"version": "<parsed>"` line — the top-level one in every
// manifest shape we ship — so the edit never touches a nested version field. A minified or
// reformatted manifest has no such line; there the only safe rewrite is an unambiguous one,
// so fall back to a mid-line match and only when the file holds exactly one.
function locateJsonVersion(text, parsed) {
  const re = /^([ \t]*)"version"\s*:\s*"([^"]*)"/gm;
  let best = null;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m[2] !== parsed) continue;
    if (!best || m[1].length < best.indent.length) {
      best = { index: m.index, length: m[0].length, indent: m[1] };
    }
  }
  if (best) return best;
  const loose = /"version"\s*:\s*"([^"]*)"/g;
  const hits = [];
  while ((m = loose.exec(text)) !== null) {
    if (m[1] === parsed) hits.push({ index: m.index, length: m[0].length, indent: '' });
  }
  return hits.length === 1 ? hits[0] : null;
}

function writeBlocker(abs) {
  try {
    fs.accessSync(abs, fs.constants.W_OK);
  } catch (e) {
    return `not writable (${e.code || e.message})`;
  }
  try {
    fs.accessSync(path.dirname(abs), fs.constants.W_OK);
  } catch (e) {
    return `directory not writable (${e.code || e.message})`;
  }
  return null;
}

function planJson(target, next) {
  let text;
  try {
    text = fs.readFileSync(target.abs, 'utf8');
  } catch (e) {
    return { ...target, error: `unreadable (${e.code || e.message})` };
  }
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    return { ...target, error: `unparsable JSON (${e.message})` };
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj) || typeof obj.version !== 'string') {
    return { ...target, error: 'no top-level "version" string' };
  }
  if (!SEMVER.test(obj.version)) {
    return { ...target, error: `current version "${obj.version}" is not semver` };
  }
  const hit = locateJsonVersion(text, obj.version);
  if (!hit) return { ...target, error: 'could not locate the "version" line to rewrite' };
  if (obj.version === next) return { ...target, status: 'unchanged', from: obj.version };
  const blocker = writeBlocker(target.abs);
  if (blocker) return { ...target, error: blocker };
  const head = text.slice(0, hit.index);
  const line = text.slice(hit.index, hit.index + hit.length);
  const rewritten = line.replace(/"([^"]*)"(\s*)$/, `"${next}"$2`);
  return {
    ...target,
    status: 'stamped',
    from: obj.version,
    original: text,
    content: head + rewritten + text.slice(hit.index + hit.length),
  };
}

function planText(target, next) {
  let text;
  try {
    text = fs.readFileSync(target.abs, 'utf8');
  } catch (e) {
    return { ...target, error: `unreadable (${e.code || e.message})` };
  }
  let hits = 0;
  let changed = 0;
  let out = text;
  for (const mark of target.marks) {
    mark.lastIndex = 0;
    out = out.replace(mark, (whole, pre, old, post) => {
      hits += 1;
      if (old === next) return whole;
      changed += 1;
      return `${pre}${next}${post}`;
    });
  }
  if (hits === 0) return { ...target, status: 'skipped', note: 'no fnd version markers' };
  if (changed === 0) return { ...target, status: 'unchanged', note: `${hits} marker(s)` };
  const blocker = writeBlocker(target.abs);
  if (blocker) return { ...target, error: blocker };
  return {
    ...target,
    status: 'stamped',
    note: `${changed}/${hits} marker(s)`,
    original: text,
    content: out,
  };
}

const STAGE_SUFFIX = '.bump-version-tmp';

function discard(paths) {
  for (const p of paths) {
    try {
      fs.unlinkSync(p);
    } catch (_) {
      /* best effort: the stage file was never created, or is already gone */
    }
  }
}

// Stage every new file next to its target, then rename them all in. A failure while staging
// leaves the tree untouched; a failure mid-rename puts the already-renamed targets back.
function writeAll(stamped, next) {
  const staged = [];
  for (const p of stamped) {
    const tmp = p.abs + STAGE_SUFFIX;
    try {
      fs.writeFileSync(tmp, p.content);
      // rename replaces the inode — carry the target's mode (install.sh is executable)
      fs.chmodSync(tmp, fs.statSync(p.abs).mode);
    } catch (e) {
      discard(staged.map((s) => s.tmp).concat(tmp));
      return `refusing to stamp ${next} — could not stage ${p.rel} (${e.code || e.message});\nnothing was written.`;
    }
    staged.push({ plan: p, tmp });
  }

  const done = [];
  for (const s of staged) {
    try {
      fs.renameSync(s.tmp, s.plan.abs);
    } catch (e) {
      const stuck = [];
      for (const p of done) {
        try {
          fs.writeFileSync(p.abs, p.original);
        } catch (_) {
          stuck.push(p.rel);
        }
      }
      discard(staged.map((x) => x.tmp));
      const head = `aborted stamping ${next} — could not write ${s.plan.rel} (${e.code || e.message});`;
      return stuck.length
        ? `${head}\nROLLBACK INCOMPLETE — ${stuck.join(', ')} may still hold ${next}; restore them by hand.`
        : `${head}\nrolled back ${done.length} target(s) — nothing was written.`;
    }
    done.push(s.plan);
  }
  return null;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = path.resolve(args.root || path.resolve(__dirname, '..', '..', '..'));
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    fail(1, `--root "${root}" is not a directory`);
  }

  const targets = TARGETS.map((t) => ({ ...t, abs: path.join(root, t.rel) }));
  const canonical = targets.find((t) => t.canonical);
  let current = null;
  if (fs.existsSync(canonical.abs)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(canonical.abs, 'utf8'));
      if (parsed && typeof parsed.version === 'string') current = parsed.version;
    } catch (_) {
      current = null;
    }
  }

  let next;
  if (KEYWORDS.includes(args.version)) {
    if (current === null) {
      fail(2, `${canonical.rel} is missing or unparsable — cannot compute a ${args.version} bump`);
    }
    next = bumpFrom(current, args.version);
  } else {
    next = args.version;
    if (!SEMVER.test(next)) {
      fail(1, `"${next}" is not a valid semver version (expected X.Y.Z, or major|minor|patch)`);
    }
  }

  const plans = targets.map((t) => {
    if (!fs.existsSync(t.abs)) {
      if (t.required) return { ...t, error: 'required target is missing' };
      return { ...t, status: 'missing', note: 'optional target — not present' };
    }
    return t.kind === 'json' ? planJson(t, next) : planText(t, next);
  });

  const broken = plans.filter((p) => p.error);
  if (broken.length > 0) {
    process.stderr.write(
      `bump-version: refusing to stamp ${next} — ${broken.length} target(s) failed:\n` +
        broken.map((p) => `  ${p.rel} — ${p.error}\n`).join('') +
        'nothing was written.\n'
    );
    process.exit(2);
  }

  if (!args.dryRun) {
    const problem = writeAll(plans.filter((p) => p.status === 'stamped'), next);
    if (problem) fail(2, problem);
  }

  const lines = [];
  for (const p of plans) {
    const detail = p.status === 'stamped' && p.from ? `${p.from} -> ${next}` : p.note || (p.from ? `${p.from}` : next);
    lines.push(`  ${p.status.padEnd(9)} ${p.rel}${detail ? `  ${detail}` : ''}`);
  }

  const tally = {};
  for (const p of plans) tally[p.status] = (tally[p.status] || 0) + 1;
  const summary = Object.keys(tally)
    .sort()
    .map((k) => `${tally[k]} ${k}`)
    .join(', ');
  const from = current === null ? 'unknown' : current;
  process.stdout.write(
    `bump-version: ${from} -> ${next}${args.dryRun ? '  (dry run — nothing written)' : ''}\n` +
      `${lines.join('\n')}\n` +
      `${plans.length} targets: ${summary}\n`
  );
}

main();
