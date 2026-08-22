#!/usr/bin/env node
/*
 * doctor.cjs — static install verification (multi-harness port, Verification story layer 1).
 *
 * No model, no session, no network: everything here is a filesystem/exec-bit/JSON assertion that
 * answers the one question a fresh install cannot answer for itself — "the clone succeeded, but
 * will the host ever load it?". Runs at the end of scripts/install.sh and standalone any time;
 * it is also the first row the smoke-test skill executes from inside a session.
 *
 * Usage:
 *   node doctor.cjs                          # bundle checks only
 *   node doctor.cjs --target cursor          # + the Cursor install location
 *   node doctor.cjs --target opencode        # + the OpenCode install location
 *   node doctor.cjs --target codex           # + the Codex subagent links
 *   node doctor.cjs --root <dir> --home <dir>   # overrides (tests, non-standard installs)
 *
 * Every check prints exactly one PASS / FAIL / SKIP line. SKIP means "nothing to verify here yet"
 * (an optional manifest, a directory M4 has not generated) and never fails the run; the exit code
 * is 1 if and only if at least one check FAILed. This script only reports — it never repairs.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const MIN_NODE_MAJOR = 18;

const MANIFESTS = [
  { name: 'manifest:claude', rel: '.claude-plugin/plugin.json', host: 'Claude Code', required: true },
  { name: 'manifest:cursor', rel: '.cursor-plugin/plugin.json', host: 'Cursor', required: false },
  { name: 'manifest:codex', rel: '.codex-plugin/plugin.json', host: 'Codex CLI', required: false },
];

// Manifest keys whose value is a path the host resolves against the plugin root. A pointer that
// does not resolve is the "clone succeeded but the host loads nothing" failure this script exists
// for; `generated` marks the ones M4/M5/M6 still have to produce (absent = SKIP until then).
const MANIFEST_POINTERS = {
  '.cursor-plugin/plugin.json': [
    { key: 'skills' },
    { key: 'agents', generated: true },
    { key: 'hooks', generated: true },
  ],
  '.codex-plugin/plugin.json': [
    { key: 'skills' },
    { key: 'hooks', generated: true },
    { key: 'mcpServers', generated: true },
    // Declared only if M1b finds that Codex reads an agents pointer from a plugin manifest;
    // until then the subagents are linked by scripts/install.sh and this row stays silent.
    { key: 'agents', generated: true },
  ],
};

const GENERATED_DIRS = ['agents-cursor', 'agents-codex', 'agents-opencode', 'commands-opencode'];
const GENERATOR_REL = 'scripts/gen-host-adapters.cjs';

// Install roots per --target, matching scripts/install.sh: the installer writes its record to
// <root>/.fnd-install-mode and points every entry back into this checkout. `probe` lists the
// entries a hand-made install would still create, so an install without the record is recognized.
// M1C-DEFAULT: the OpenCode root is provisional — spike M1c picks the final lever.
// Codex is a HALF-cache host: skills, hooks and MCP come from its marketplace cache, but the TOML
// subagents have no verified plugin-level channel (M1b), so scripts/install.sh links them locally —
// and an install without those links spawns nothing, which is what this row exists to say.
const HOST_INSTALLS = {
  cursor: { root: (home) => path.join(home, '.cursor', 'plugins', 'local'), probe: ['fnd'] },
  opencode: { root: (home, xdg) => path.join(xdg || path.join(home, '.config'), 'opencode'), probe: [] },
  codex: {
    root: (home) => path.join(home, '.codex'),
    probe: ['agents/jira-reader.toml'],
    note: 'subagents only — skills/hooks/MCP come from ~/.codex/plugins/cache',
  },
};
// Version-cache hosts: the host clones into its own cache, so there is no local install to inspect.
const CACHE_HOSTS = {
  claude: '~/.claude/plugins/cache (managed by /plugin install)',
};

const INSTALL_MODE_FILE = '.fnd-install-mode';

const rows = [];
function report(status, name, detail) {
  rows.push({ status, name, detail });
}
const pass = (n, d) => report('PASS', n, d);
const fail = (n, d) => report('FAIL', n, d);
const skip = (n, d) => report('SKIP', n, d);

function out(line) {
  try {
    process.stdout.write(line + '\n');
  } catch (_) {
    /* a closed pipe (`| head`) is not a doctor failure */
  }
}

const USAGE = 'usage: doctor.cjs [--target cursor|opencode|codex|claude] [--root <dir>] [--home <dir>]\n';

function usage(msg) {
  if (!msg) {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  process.stderr.write('doctor: ' + msg + '\n' + USAGE);
  process.exit(2);
}

function parseArgs(argv) {
  const opts = { target: null, root: null, home: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') usage('');
    else if (a === '--target' || a === '--root' || a === '--home') {
      const v = argv[++i];
      if (!v || v.startsWith('--')) usage(a + ' needs a value');
      opts[a.slice(2)] = v;
    } else usage('unknown argument ' + a);
  }
  if (opts.target && !HOST_INSTALLS[opts.target] && !CACHE_HOSTS[opts.target]) {
    usage('unknown target ' + opts.target);
  }
  return opts;
}

function realpath(p) {
  try {
    return fs.realpathSync(p);
  } catch (_) {
    return path.resolve(p);
  }
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch (_) {
    return false;
  }
}

// The repo root is what a host install must resolve INTO: the nearest ancestor holding .git.
// A checkout without .git (tarball download, vendored copy, sparse export) still has the layout
// scripts/install.sh assumes — <root>/plugins/fnd — and install.sh records THAT root, so fall
// back to it before falling back to the plugin root itself.
function findRepoRoot(pluginRoot) {
  let dir = pluginRoot;
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  const plugins = path.dirname(pluginRoot);
  if (path.basename(plugins) === 'plugins' && path.dirname(plugins) !== plugins) {
    return path.dirname(plugins);
  }
  return pluginRoot;
}

function readManifest(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return { error: e.code === 'ENOENT' ? 'missing' : 'unreadable: ' + e.message };
  }
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

function checkNode() {
  const major = Number(process.versions.node.split('.')[0]);
  const detail = 'node ' + process.versions.node + ' (>= ' + MIN_NODE_MAJOR + ' required)';
  if (Number.isFinite(major) && major >= MIN_NODE_MAJOR) pass('node', detail);
  else fail('node', detail);
}

function checkManifests(pluginRoot) {
  const found = [];
  for (const m of MANIFESTS) {
    const file = path.join(pluginRoot, m.rel);
    const res = readManifest(file);
    if (res.error === 'missing') {
      if (m.required) fail(m.name, m.rel + ' missing — this is not an fnd plugin root');
      else skip(m.name, m.rel + ' absent — ' + m.host + ' not packaged here');
      continue;
    }
    if (res.error) {
      fail(m.name, m.rel + ' ' + res.error);
      continue;
    }
    found.push({ rel: m.rel, version: res.version });
    pass(m.name, m.rel + ' version ' + res.version);
  }
  if (found.length < 2) {
    skip('version-sync', 'fewer than 2 manifests present — nothing to compare');
    return;
  }
  const versions = [...new Set(found.map((f) => f.version))];
  if (versions.length === 1) {
    pass('version-sync', found.length + ' manifests all at ' + versions[0]);
  } else {
    fail(
      'version-sync',
      'version drift: ' +
        found.map((f) => f.rel + '=' + f.version).join(', ') +
        ' — run scripts/bump-version.cjs'
    );
  }
}

function checkPointers(pluginRoot) {
  for (const m of MANIFESTS) {
    const spec = MANIFEST_POINTERS[m.rel];
    if (!spec) continue;
    let data;
    try {
      data = JSON.parse(fs.readFileSync(path.join(pluginRoot, m.rel), 'utf8'));
    } catch (_) {
      continue; // absent or unparseable — checkManifests already owns that row
    }
    if (!data || typeof data !== 'object') continue;
    const label = 'pointers:' + m.name.split(':')[1];
    const broken = [];
    const pending = [];
    let declared = 0;
    let resolved = 0;
    for (const { key, generated } of spec) {
      const value = data[key];
      if (value === undefined) continue;
      declared++;
      if (typeof value !== 'string' || !value) {
        broken.push(key + ': not a path string');
      } else if (path.isAbsolute(value) || value.startsWith('~') || value.split('/').includes('..')) {
        broken.push(key + ': "' + value + '" must be relative and free of ".."');
      } else if (fs.existsSync(path.join(pluginRoot, value))) {
        resolved++;
      } else if (generated) {
        pending.push(key + ' -> ' + value);
      } else {
        broken.push(key + ': "' + value + '" does not exist');
      }
    }
    if (broken.length) fail(label, broken.join('; '));
    else if (!declared) skip(label, 'no path pointers declared — host auto-discovery only');
    else if (pending.length) {
      skip(label, resolved + '/' + declared + ' resolve; not generated yet (M4/M5/M6): ' + pending.join(', '));
    } else pass(label, declared + ' pointer(s) resolve');
  }
}

function checkHooks(pluginRoot) {
  const dir = path.join(pluginRoot, 'hooks');
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (e) {
    fail('hooks', 'hooks/ unreadable: ' + e.message);
    return;
  }
  const offenders = [];
  let shell = 0;
  let node = 0;
  for (const entry of entries.sort()) {
    const file = path.join(dir, entry);
    let st;
    try {
      st = fs.statSync(file);
    } catch (e) {
      offenders.push(entry + ' (unreadable: ' + e.code + ')');
      continue;
    }
    if (!st.isFile()) continue;
    // static content, not something a host executes: prose, the per-host wiring files
    // (hooks/hooks-cursor.json, hooks/hooks-codex.json) and the declarative rule sets a host
    // reads rather than runs (hooks/no-verify.rules — Codex execpolicy Starlark) that M5 lands
    // in this same dir
    if (entry.endsWith('.md') || entry.endsWith('.json') || entry.endsWith('.rules')) continue;
    if (entry.endsWith('.cjs')) {
      node++;
      continue; // node-invoked by every wiring — the exec bit is irrelevant
    }
    if (st.mode & 0o111) shell++;
    else offenders.push(entry + ' (not executable)');
  }
  if (offenders.length) fail('hooks', offenders.join(', ') + ' — chmod +x');
  else if (shell + node === 0) fail('hooks', 'hooks/ has no hook scripts');
  else pass('hooks', shell + ' executable + ' + node + ' node-invoked script(s)');
}

function checkGenerated(pluginRoot, repoRoot) {
  let present = 0;
  for (const name of GENERATED_DIRS) {
    const dir = path.join(pluginRoot, name);
    if (!fs.existsSync(dir)) {
      skip('gen:' + name, 'not generated yet (M4)');
      continue;
    }
    if (!isDir(dir)) {
      fail('gen:' + name, name + ' exists but is not a directory');
      continue;
    }
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => !f.startsWith('.'));
    } catch (e) {
      fail('gen:' + name, name + ' unreadable: ' + e.message);
      continue;
    }
    if (!files.length) {
      fail('gen:' + name, name + ' is empty — re-run ' + GENERATOR_REL);
      continue;
    }
    present++;
    pass('gen:' + name, files.length + ' file(s)');
  }

  const generator = path.join(pluginRoot, GENERATOR_REL);
  if (!fs.existsSync(generator)) {
    skip('generator-sync', GENERATOR_REL + ' absent (M4)');
    return;
  }
  if (!present) {
    skip('generator-sync', 'nothing generated yet (M4)');
    return;
  }
  let src = '';
  try {
    src = fs.readFileSync(generator, 'utf8');
  } catch (e) {
    fail('generator-sync', GENERATOR_REL + ' unreadable: ' + e.message);
    return;
  }
  if (!src.includes('--check')) {
    skip('generator-sync', GENERATOR_REL + ' has no --check flag — drift not verified');
    return;
  }
  const r = spawnSync(process.execPath, [generator, '--check'], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 120000,
  });
  if (r.error) {
    fail('generator-sync', 'could not run ' + GENERATOR_REL + ': ' + r.error.message);
    return;
  }
  if (r.status === 0) {
    pass('generator-sync', 'generated dirs match ' + GENERATOR_REL);
    return;
  }
  const why = ((r.stderr || '') + (r.stdout || '')).trim().split('\n')[0] || 'exit ' + r.status;
  fail('generator-sync', 'drift reported by ' + GENERATOR_REL + ': ' + why.slice(0, 200));
}

function readInstallRecord(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (_) {
    return null;
  }
  const rec = { mode: '', repo: '', version: '', entries: [] };
  for (const line of raw.split('\n')) {
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1).trim();
    if (key === 'entry') rec.entries.push(value);
    else if (key === 'mode' || key === 'repo' || key === 'version') rec[key] = value;
  }
  return rec;
}

// One installed entry: a symlink install must resolve into this checkout, a copy install must be
// a real file/dir. Returns null when the entry is healthy, else the reason it is not.
function entryProblem(entry, mode, repoReal) {
  let lst;
  try {
    lst = fs.lstatSync(entry);
  } catch (_) {
    return 'missing';
  }
  if (mode === 'copy') return lst.isSymbolicLink() ? 'symlink in a copy install' : null;
  if (!lst.isSymbolicLink()) return 'not a symlink';
  if (!fs.existsSync(entry)) return 'broken symlink';
  const target = realpath(entry);
  if (target !== repoReal && !target.startsWith(repoReal + path.sep)) {
    return 'points outside this checkout → ' + target;
  }
  return null;
}

function checkHost(target, homeDir, xdgConfigHome, pluginRoot, repoRoot) {
  if (!target) {
    skip('install', 'no --target given — host install location not checked');
    return;
  }
  const label = 'install:' + target;
  if (CACHE_HOSTS[target]) {
    skip(label, target + ' installs into ' + CACHE_HOSTS[target]);
    return;
  }

  const host = HOST_INSTALLS[target];
  const note = host.note ? ' [' + host.note + ']' : '';
  const root = host.root(homeDir, xdgConfigHome);
  const modeFile = path.join(root, INSTALL_MODE_FILE);
  const repoReal = realpath(repoRoot);
  const record = readInstallRecord(modeFile);

  // No installer record: a hand-made symlink at the documented path still counts as installed.
  if (!record) {
    for (const rel of host.probe) {
      const entry = path.join(root, rel);
      if (!fs.lstatSync(entry, { throwIfNoEntry: false })) continue;
      const problem = entryProblem(entry, 'symlink', repoReal);
      if (problem) fail(label, entry + ': ' + problem);
      else pass(label, entry + ' → ' + realpath(entry) + ' (no installer record)' + note);
      return;
    }
    fail(label, 'not installed — no ' + modeFile + ' (run scripts/install.sh --target ' + target + ')' + note);
    return;
  }

  if (record.repo && realpath(record.repo) !== repoReal) {
    fail(label, modeFile + ' records a different checkout: ' + record.repo);
    return;
  }
  const mode = record.mode === 'copy' ? 'copy' : 'symlink';
  if (!record.entries.length) {
    fail(label, modeFile + ' records no entries — re-run scripts/install.sh --target ' + target);
    return;
  }

  const problems = [];
  for (const entry of record.entries) {
    const problem = entryProblem(entry, mode, repoReal);
    if (problem) problems.push(entry + ' (' + problem + ')');
  }
  if (problems.length) {
    const shown = problems.slice(0, 3).join(', ');
    const more = problems.length > 3 ? ' … +' + (problems.length - 3) + ' more' : '';
    fail(label, problems.length + '/' + record.entries.length + ' entries broken: ' + shown + more);
    return;
  }

  // A --copy install does not follow `git pull`, so its recorded version is the one that is live.
  const here = readManifest(path.join(pluginRoot, '.claude-plugin', 'plugin.json'));
  if (mode === 'copy' && !here.error && record.version && record.version !== here.version) {
    fail(
      label,
      'copy install is stale: ' + record.version + ' vs ' + here.version + ' — re-run install.sh'
    );
    return;
  }
  pass(label, mode + ' install, ' + record.entries.length + ' entry(ies) live (root: ' + root + ')' + note);
}

/*
 * Codex arms plugin hooks behind TWO user actions the install cannot perform: the `[features]
 * hooks` gate (its default varies by CLI version) and a per-content-hash trust review in `/hooks`.
 * Skills and MCP load without either, so an install with the whole guard layer dormant — session
 * conventions, the prompt-JSON guard, mcp-slim, BOTH git guards — looks identical to a healthy one.
 * The gate is a file this script can read; the trust review is host state it cannot, so that row is
 * an always-printed reminder with the one command that proves the answer either way.
 */
function checkCodexHooks(homeDir) {
  const cfg = path.join(homeDir, '.codex', 'config.toml');
  let text = null;
  try {
    text = fs.readFileSync(cfg, 'utf8');
  } catch (_) {}
  if (text === null) {
    skip('codex:hooks-gate', cfg + ' absent — add [features] hooks = true (the default varies by CLI version)');
  } else {
    // Section-scoped on purpose: a `hooks = true` under some other table says nothing about the
    // feature gate. Table headers are the only thing that has to be parsed to find the right one.
    const lines = text.split(/\r?\n/);
    let section = '';
    let value = null;
    for (const raw of lines) {
      const line = raw.replace(/#.*$/, '').trim();
      const header = /^\[([^\]]+)\]$/.exec(line);
      if (header) {
        section = header[1].trim();
        continue;
      }
      const kv = /^hooks\s*=\s*(true|false)\b/.exec(line);
      if (kv && section === 'features') value = kv[1];
    }
    if (value === 'true') pass('codex:hooks-gate', '[features] hooks = true in ' + cfg);
    else if (value === 'false') skip('codex:hooks-gate', '[features] hooks = false in ' + cfg + ' — every fnd hook is off, including the commit guards');
    else skip('codex:hooks-gate', 'no [features] hooks entry in ' + cfg + ' — set it to true (the default varies by CLI version)');
  }
  skip(
    'codex:hooks-trust',
    'not inspectable — non-managed hooks run only after a per-content-hash review in /hooks; prove it with ' +
      '`git commit --no-verify -m probe` in a repo with git hooks (it must be blocked)'
  );
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const pluginRoot = path.resolve(opts.root || path.join(__dirname, '..'));
  const repoRoot = findRepoRoot(pluginRoot);
  const homeDir = opts.home ? path.resolve(opts.home) : os.homedir();
  // --home is the whole override: an ambient XDG_CONFIG_HOME must not re-target a sandboxed run.
  const xdgConfigHome = opts.home ? null : process.env.XDG_CONFIG_HOME || null;

  checkNode();
  checkManifests(pluginRoot);
  checkPointers(pluginRoot);
  checkHooks(pluginRoot);
  checkGenerated(pluginRoot, repoRoot);
  checkHost(opts.target, homeDir, xdgConfigHome, pluginRoot, repoRoot);
  if (opts.target === 'codex') checkCodexHooks(homeDir);

  const width = rows.reduce((w, r) => Math.max(w, r.name.length), 0);
  out('fnd doctor — plugin root: ' + pluginRoot);
  for (const r of rows) out(r.status + '  ' + r.name.padEnd(width) + '  ' + r.detail);

  const counts = { PASS: 0, FAIL: 0, SKIP: 0 };
  for (const r of rows) counts[r.status]++;
  out('doctor: ' + counts.PASS + ' passed, ' + counts.FAIL + ' failed, ' + counts.SKIP + ' skipped');
  // exitCode, not exit(): a piped stdout write can still be in flight when exit() tears the process down
  process.exitCode = counts.FAIL > 0 ? 1 : 0;
}

main();
