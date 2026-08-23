#!/usr/bin/env node
/*
 * garden-check.cjs — repo-side hygiene gate for the multi-harness port (M8).
 *
 * doctor.cjs answers "will this host load the install?"; this script answers the question that
 * comes one step earlier — "is the tree we are about to push still internally consistent?".
 * Six rot patterns, all of them silent (nothing fails at runtime, the model just reads a path that
 * is not there, or a host loads content the generator no longer produces):
 *
 *   links        a skill/reference/rule points at a bundled file that was renamed or deleted
 *   skill-size   a SKILL.md grows past the size Codex is reported to cap skills at (WARN only —
 *                the cap is unconfirmed until the M1b spike, same watchlist as skill-neutral-lint)
 *   generated    a generated adapter dir was hand-edited or left stale (delegated to the generator)
 *   version      the three manifests or the documented version stamps drifted apart
 *   rules-bundle a vendored foundation rule was edited in place instead of upstream + re-imported
 *   hook-wiring  a per-host wiring file stopped parsing, or points at a hook script that is gone
 *
 * Usage:
 *   node garden-check.cjs                 # check the checkout this script ships in
 *   node garden-check.cjs --root <dir>    # check another checkout (tests, CI on a copy)
 *
 * One PASS / FAIL / WARN line per finding, then a summary. WARN never fails the run; the exit code
 * is 1 if and only if at least one row FAILed (2 for a usage error). Reports only, never repairs —
 * every FAIL names the command that fixes it.
 *
 * Node built-ins only (repo policy): fs, path, child_process.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const PLUGIN_REL = path.join('plugins', 'fnd');
const GENERATOR_REL = path.join('scripts', 'gen-host-adapters.cjs');
// Same threshold and same file set as tests/skill-neutral-lint.sh — one number, two readers, so a
// confirmed Codex cap moves both in one edit.
const SIZE_WARN_BYTES = 8000;

// Content directories whose prose is read verbatim by a model on every host: a dead path here is a
// dead end for the reader. Generated dirs are deliberately absent — they are checked as a whole by
// the generator's own --check, and their bodies are rewrites of agents/, not hand-maintained text.
const LINK_DIRS = ['skills', 'references', 'rules', 'agents'];

// Version stamps outside the manifests. Mirrors the marker contract in
// plugins/fnd/scripts/bump-version.cjs — re-derived rather than imported, so this file has no
// runtime dependency on that script. Per FILE, because that script's TARGETS table is per file too:
// install.sh is stamped on its `FND_VERSION="…"` assignment only, so an `fnd v<semver>` line in it
// is prose the bump would never touch — asserting it here would be a FAIL no bump could clear.
const MARK_ENV = /FND_VERSION="([^"\n]*)"/g;
const MARK_FND_V = /\bfnd v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)\b/g;
const STAMPED_FILES = [
  { rel: 'README.md', marks: [MARK_ENV, MARK_FND_V] },
  { rel: path.join('scripts', 'install.sh'), marks: [MARK_ENV] },
];

// How the two version rows tell a maintainer to fix drift. Spelled from the repo root, the only
// directory the rows' other paths are relative to — `scripts/bump-version.cjs` is not a file.
const BUMP_CMD = 'node plugins/fnd/scripts/bump-version.cjs';

// The Claude Code manifest is the canonical version stamp — every other manifest and every
// documented text marker is bumped from it.
const CANONICAL_MANIFEST_REL = path.join('.claude-plugin', 'plugin.json');

const MANIFESTS = [
  { rel: CANONICAL_MANIFEST_REL, host: 'Claude Code', required: true },
  { rel: path.join('.cursor-plugin', 'plugin.json'), host: 'Cursor', required: false },
  { rel: path.join('.codex-plugin', 'plugin.json'), host: 'Codex CLI', required: false },
];

const rows = [];
function report(status, name, detail) {
  rows.push({ status, name, detail });
}
const pass = (n, d) => report('PASS', n, d);
const fail = (n, d) => report('FAIL', n, d);
const warn = (n, d) => report('WARN', n, d);

function out(line) {
  try {
    process.stdout.write(line + '\n');
  } catch (_) {
    /* a closed pipe (`| head`) is not a garden failure */
  }
}

const USAGE = 'usage: garden-check.cjs [--root <repo-dir>]\n';

function usage(msg) {
  if (!msg) {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  process.stderr.write('garden: ' + msg + '\n' + USAGE);
  process.exit(2);
}

function parseArgs(argv) {
  const opts = { root: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') usage('');
    else if (a === '--root') {
      const v = argv[++i];
      if (!v || v.startsWith('--')) usage('--root needs a value');
      opts.root = v;
    } else usage('unknown argument ' + a);
  }
  return opts;
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (_) {
    return null;
  }
}

function exists(p) {
  try {
    fs.statSync(p);
    return true;
  } catch (_) {
    return false;
  }
}

// Offenders are printed inline, so a long list has to stay one readable line.
function summarize(items, cap) {
  const shown = items.slice(0, cap).join('; ');
  return items.length > cap ? shown + ' … +' + (items.length - cap) + ' more' : shown;
}

function walkMarkdown(dir, acc) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return acc;
  }
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const file = path.join(dir, e.name);
    if (e.isDirectory()) walkMarkdown(file, acc);
    else if (/\.(md|mdc)$/.test(e.name)) acc.push(file);
  }
  return acc;
}

/*
 * Markdown links are read line by line with code stripped: a link inside backticks or a fenced
 * block is documentation ABOUT a link (rules/SOURCE.md quotes the pre-import `mdc:` form, skills
 * show `[View theme](THEME_URL)` templates), not a link this repo has to keep alive.
 * Path mentions are read from the raw line instead — `<plugin root>/references/x.md` is written
 * inside backticks by convention, so stripping code would erase the whole check.
 */
function strippedLines(text) {
  let fence = false;
  return text.split('\n').map((line) => {
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence;
      return '';
    }
    return fence ? '' : line.replace(/`[^`]*`/g, '');
  });
}

// A link target worth resolving: not a URL, not an anchor, not a `mdc:` workspace path (those
// address the theme repo a rule is read in, not this bundle), no placeholder punctuation, and
// shaped like a path — a slash or a file extension. `(url)`, `(…)`, `(THEME_URL)` are prose.
function linkTarget(raw) {
  if (/^(https?:|mailto:|mdc:|#)/.test(raw) || raw.includes('://')) return null;
  if (/[<>…{}$*|]/.test(raw)) return null;
  const target = raw.split('#')[0].split('?')[0];
  if (!target) return null;
  if (!target.includes('/') && !/\.[A-Za-z0-9]{1,5}$/.test(target)) return null;
  return target;
}

function checkLinks(repoRoot, pluginRoot) {
  const files = [];
  for (const rel of LINK_DIRS) walkMarkdown(path.join(pluginRoot, rel), files);
  // Repo-root prose is read by humans installing the plugin, and the per-host quickstarts under
  // docs/ rot exactly like skill prose does — a dead install path costs someone an install.
  for (const rel of ['README.md', 'CLAUDE.md']) {
    const f = path.join(repoRoot, rel);
    if (exists(f)) files.push(f);
  }
  walkMarkdown(path.join(repoRoot, 'docs'), files);

  if (!files.length) {
    fail('links', 'no markdown found under ' + PLUGIN_REL + ' — wrong --root?');
    return;
  }

  let checked = 0;
  let deadFiles = 0;
  for (const file of files) {
    const text = readText(file);
    if (text === null) {
      fail('links:' + path.relative(repoRoot, file), 'unreadable');
      deadFiles++;
      continue;
    }
    const dead = [];
    strippedLines(text).forEach((line, i) => {
      const re = /\[[^\]]*\]\(([^)\s]+)\)/g;
      let m;
      while ((m = re.exec(line))) {
        const target = linkTarget(m[1]);
        if (target === null) continue;
        checked++;
        if (path.isAbsolute(target)) {
          dead.push('line ' + (i + 1) + ': ' + target + ' (absolute path — nothing resolves it on another machine)');
        } else if (!exists(path.resolve(path.dirname(file), target))) {
          dead.push('line ' + (i + 1) + ': ' + target);
        }
      }
    });
    text.split('\n').forEach((line, i) => {
      const re = /<plugin root>\/([A-Za-z0-9._/-]*)/g;
      let m;
      while ((m = re.exec(line))) {
        // Trailing sentence punctuation belongs to the prose, not to the path.
        const rel = m[1].replace(/[.,;:]+$/, '');
        checked++;
        if (!exists(rel ? path.join(pluginRoot, rel) : pluginRoot)) {
          dead.push('line ' + (i + 1) + ': <plugin root>/' + rel);
        }
      }
    });
    if (dead.length) {
      deadFiles++;
      fail('links:' + path.relative(repoRoot, file), summarize(dead, 3) + ' — renamed or deleted');
    }
  }
  if (!deadFiles) {
    pass('links', checked + ' link(s) and path mention(s) in ' + files.length + ' file(s) resolve');
  }
}

function checkSkillSizes(pluginRoot) {
  const dir = path.join(pluginRoot, 'skills');
  let names;
  try {
    names = fs.readdirSync(dir).sort();
  } catch (e) {
    fail('skill-size', 'skills/ unreadable: ' + e.message);
    return;
  }
  let found = 0;
  let over = 0;
  for (const name of names) {
    const file = path.join(dir, name, 'SKILL.md');
    let st;
    try {
      st = fs.statSync(file);
    } catch (_) {
      continue;
    }
    found++;
    if (st.size > SIZE_WARN_BYTES) {
      over++;
      warn(
        'skill-size:' + name,
        st.size + ' B over the ' + SIZE_WARN_BYTES + ' B Codex watchlist — move detail into a REFERENCE.md ' +
          '(cap unconfirmed until the M1b spike, so this is not a failure)'
      );
    }
  }
  if (!found) fail('skill-size', 'no SKILL.md files under skills/');
  else pass('skill-size', found + ' skill(s), ' + over + ' over ' + SIZE_WARN_BYTES + ' B');
}

function checkGenerated(repoRoot, pluginRoot) {
  const generator = path.join(pluginRoot, GENERATOR_REL);
  if (!exists(generator)) {
    fail('generated', PLUGIN_REL + '/' + GENERATOR_REL + ' is missing — generated adapters cannot be verified');
    return;
  }
  const r = spawnSync(process.execPath, [generator, '--check'], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 120000,
  });
  if (r.error) {
    fail('generated', 'could not run the generator: ' + r.error.message);
    return;
  }
  if (r.status === 0) {
    pass('generated', (r.stdout || '').trim().split('\n')[0] || 'generated adapters in sync');
    return;
  }
  const problems = ((r.stderr || '') + (r.stdout || '')).trim().split('\n').filter(Boolean);
  fail(
    'generated',
    summarize(problems, 3) + ' — never hand-edit generated dirs; re-run node ' + PLUGIN_REL + '/' + GENERATOR_REL
  );
}

function manifestVersion(file) {
  const raw = readText(file);
  if (raw === null) return { error: 'missing' };
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    return { error: 'invalid JSON: ' + e.message };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { error: 'not a JSON object' };
  if (typeof data.version !== 'string' || !data.version) return { error: 'no "version" string' };
  return { version: data.version };
}

/*
 * The Shopify-AI-Toolkit cautionary tale in one row: per-harness manifests that carry their own
 * version stamp drift the moment one of them is edited by hand. Same comparison doctor.cjs makes
 * on an install, re-derived here so a push cannot carry the drift in the first place — plus the
 * documented text markers, because bump-version.cjs stamps them in the same all-or-nothing pass.
 */
function checkVersions(repoRoot, pluginRoot) {
  const found = [];
  const broken = [];
  for (const m of MANIFESTS) {
    const res = manifestVersion(path.join(pluginRoot, m.rel));
    if (res.error === 'missing') {
      if (m.required) broken.push(m.rel + ' missing — this is not an fnd checkout');
      else warn('version:manifests', m.rel + ' absent — ' + m.host + ' not packaged here');
      continue;
    }
    if (res.error) {
      broken.push(m.rel + ' ' + res.error);
      continue;
    }
    found.push({ rel: m.rel, version: res.version });
  }
  // Only the Claude Code manifest is the stamp bump-version.cjs writes the documented markers
  // from; the per-host manifests are copies of it. Comparing the markers against whichever
  // manifest happened to survive would report drift against a substitute, so when the canonical
  // one is absent or unparseable the stamps row is skipped — its absence is already a FAIL above.
  const canonicalEntry = found.find((f) => f.rel === CANONICAL_MANIFEST_REL);
  const canonical = canonicalEntry ? canonicalEntry.version : null;
  const versions = [...new Set(found.map((f) => f.version))];
  if (broken.length) {
    fail('version:manifests', summarize(broken, 3));
  } else if (versions.length > 1) {
    fail(
      'version:manifests',
      'drift: ' + found.map((f) => f.rel + '=' + f.version).join(', ') + ' — run ' + BUMP_CMD
    );
  } else {
    pass('version:manifests', found.length + ' manifest(s) all at ' + versions[0]);
  }

  if (!canonical) return;
  const stamped = [];
  const stale = [];
  for (const target of STAMPED_FILES) {
    const rel = target.rel;
    const text = readText(path.join(repoRoot, rel));
    if (text === null) continue;
    const lines = text.split('\n');
    for (const mark of target.marks) {
      lines.forEach((line, i) => {
        mark.lastIndex = 0;
        let m;
        while ((m = mark.exec(line))) {
          stamped.push(m[1]);
          if (m[1] !== canonical) stale.push(rel + ':' + (i + 1) + ' = ' + (m[1] || '(empty)'));
        }
      });
    }
  }
  if (stale.length) {
    fail(
      'version:stamps',
      summarize(stale, 3) + ' — manifests say ' + canonical + '; re-run ' + BUMP_CMD + ' ' + canonical
    );
  } else if (!stamped.length) {
    // bump-version.cjs treats a marker-free README as a reported no-op, not an error.
    warn('version:stamps', 'no documented version markers found — nothing outside the manifests is stamped');
  } else {
    pass('version:stamps', stamped.length + ' documented stamp(s) at ' + canonical);
  }
}

/*
 * The vendored foundation rules have exactly one legitimate edit path: change them upstream, then
 * re-import (rules/SOURCE.md documents the gh api commands and updates the size table in the same
 * pass). A local hand-edit leaves no other trace — the file still parses, Cursor still loads it,
 * and drift vs foundation becomes unfalsifiable — so the recorded byte size is the tripwire.
 */
function checkRulesBundle(pluginRoot) {
  const dir = path.join(pluginRoot, 'rules');
  const sourceMd = path.join(dir, 'SOURCE.md');
  const text = readText(sourceMd);
  if (text === null) {
    fail('rules-bundle', 'rules/SOURCE.md is missing — the bundle has no provenance to check against');
    return;
  }
  const listed = new Map();
  const rowRe = /^\|\s*`([A-Za-z0-9._-]+\.mdc)`\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|/;
  for (const line of text.split('\n')) {
    const m = rowRe.exec(line);
    if (m) listed.set(m[1], Number(m[3]));
  }
  if (!listed.size) {
    fail('rules-bundle', 'rules/SOURCE.md has no `file | upstream bytes | local bytes` table rows');
    return;
  }
  const problems = [];
  for (const [name, want] of listed) {
    let st;
    try {
      st = fs.statSync(path.join(dir, name));
    } catch (_) {
      problems.push(name + ' listed in SOURCE.md but absent from the bundle');
      continue;
    }
    if (st.size !== want) problems.push(name + ' is ' + st.size + ' B, SOURCE.md records ' + want + ' B');
  }
  if (problems.length) {
    fail(
      'rules-bundle',
      summarize(problems, 3) + ' — edit foundation upstream and re-import (rules/SOURCE.md § Refresh), ' +
        'do not hand-edit the bundle'
    );
  } else {
    pass('rules-bundle', listed.size + ' vendored rule(s) match the SOURCE.md byte record');
  }

  // fnd-authored rules have no foundation provenance and belong in no import table; anything else
  // unlisted is a rule that arrived without one.
  const orphans = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (!name.endsWith('.mdc') || listed.has(name) || name.startsWith('fnd-')) continue;
    orphans.push(name);
  }
  if (orphans.length) {
    warn('rules-bundle:provenance', summarize(orphans, 5) + ' — vendored rule(s) missing from the SOURCE.md table');
  }
}

/*
 * Every host but Claude Code loads fnd hooks from a wiring file that is not exercised by any test
 * run on this machine unless that host is installed. A wiring that stopped parsing, or that still
 * spawns a hook script someone renamed, disables the whole guard layer silently — including both
 * commit guards.
 */
function checkHookWirings(pluginRoot) {
  const wiringDirs = [path.join(pluginRoot, 'hooks'), path.join(pluginRoot, 'opencode')];
  const jsonFiles = [];
  const jsFiles = [];
  for (const dir of wiringDirs) {
    let names;
    try {
      names = fs.readdirSync(dir).sort();
    } catch (e) {
      fail('hook-wiring', path.basename(dir) + '/ unreadable: ' + e.message);
      return;
    }
    for (const name of names) {
      const file = path.join(dir, name);
      if (name.endsWith('.json')) jsonFiles.push(file);
      else if (name.endsWith('.js') || name.endsWith('.cjs')) jsFiles.push(file);
    }
  }

  const badJson = [];
  const wirings = [];
  for (const file of jsonFiles) {
    const raw = readText(file);
    const rel = path.relative(pluginRoot, file);
    if (raw === null) {
      badJson.push(rel + ' unreadable');
      continue;
    }
    let data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      badJson.push(rel + ': ' + e.message);
      continue;
    }
    if (!data || typeof data !== 'object' || Array.isArray(data) || !Object.keys(data).length) {
      badJson.push(rel + ': not a non-empty JSON object');
      continue;
    }
    if (path.basename(path.dirname(file)) === 'hooks') wirings.push({ rel, raw });
  }
  if (badJson.length) fail('hook-wiring:json', summarize(badJson, 3));
  else if (!jsonFiles.length) fail('hook-wiring:json', 'no hook wiring files found — wrong --root?');
  else pass('hook-wiring:json', jsonFiles.length + ' wiring/config file(s) parse');

  const badJs = [];
  for (const file of jsFiles) {
    const rel = path.relative(pluginRoot, file);
    const source = readText(file);
    if (source === null) {
      badJs.push(rel + ' unreadable');
      continue;
    }
    // `node --check <file>` gives up (exit 0) the moment it detects module syntax, so the OpenCode
    // adapter — the one ESM file here — would be waved through no matter how broken it is. Feeding
    // module sources through stdin with --input-type=module is the form that actually parses them.
    const esm = /^\s*(?:import|export)\b/m.test(source);
    const r = esm
      ? spawnSync(process.execPath, ['--input-type=module', '--check'], {
          input: source,
          encoding: 'utf8',
          timeout: 60000,
        })
      : spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', timeout: 60000 });
    if (r.error) badJs.push(rel + ': ' + r.error.message);
    else if (r.status !== 0) {
      const line = (r.stderr || '').split('\n').find((l) => /Error/.test(l));
      badJs.push(rel + ': ' + (line ? line.trim() : 'syntax error'));
    }
  }
  if (badJs.length) fail('hook-wiring:js', summarize(badJs, 3));
  else if (!jsFiles.length) fail('hook-wiring:js', 'no hook scripts found — wrong --root?');
  else pass('hook-wiring:js', jsFiles.length + ' hook/adapter script(s) parse');

  // Paths built at runtime (`$r/hooks/$f.md`) carry a `$` and are skipped: only literal spawns can
  // be resolved from here, and those are the ones a rename breaks.
  const missing = [];
  let targets = 0;
  for (const { rel, raw } of wirings) {
    const re = /hooks\/([A-Za-z0-9._-]+\.(?:cjs|sh|md|rules))/g;
    const seen = new Set();
    let m;
    while ((m = re.exec(raw))) {
      if (seen.has(m[1])) continue;
      seen.add(m[1]);
      targets++;
      if (!exists(path.join(pluginRoot, 'hooks', m[1]))) missing.push(rel + ' → hooks/' + m[1]);
    }
  }
  if (missing.length) fail('hook-wiring:targets', summarize(missing, 3) + ' — the wiring spawns a script that is gone');
  else pass('hook-wiring:targets', targets + ' referenced hook script(s) exist');
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  // The plugin lives at <repo>/plugins/fnd; this script at <repo>/plugins/fnd/scripts.
  const repoRoot = path.resolve(opts.root || path.join(__dirname, '..', '..', '..'));
  const pluginRoot = path.join(repoRoot, PLUGIN_REL);

  checkLinks(repoRoot, pluginRoot);
  checkSkillSizes(pluginRoot);
  checkGenerated(repoRoot, pluginRoot);
  checkVersions(repoRoot, pluginRoot);
  checkRulesBundle(pluginRoot);
  checkHookWirings(pluginRoot);

  const width = rows.reduce((w, r) => Math.max(w, r.name.length), 0);
  out('fnd garden — repo root: ' + repoRoot);
  for (const r of rows) out(r.status + '  ' + r.name.padEnd(width) + '  ' + r.detail);

  const counts = { PASS: 0, FAIL: 0, WARN: 0 };
  for (const r of rows) counts[r.status]++;
  out('garden: ' + counts.PASS + ' passed, ' + counts.FAIL + ' failed, ' + counts.WARN + ' warned');
  // exitCode, not exit(): a piped stdout write can still be in flight when exit() tears the process down
  process.exitCode = counts.FAIL > 0 ? 1 : 0;
}

main();
