#!/usr/bin/env node
/*
 * doctor.cjs — base's static install checks: what a node process can see without a session.
 *
 * No model, no network: files, exec bits, JSON. `/base-doctor` (hooks/mods/doctor.ts) runs it with
 * --json and adds the rows only a session can answer (slim's view tool registered, fnd loaded, each
 * MCP server connected). It also runs standalone.
 *
 * Usage:
 *   node doctor.cjs [--project <dir>] [--root <plugin root>] [--home <dir>] [--json]
 *     --project  the project whose installs and `.claude/base-tmp` are checked (default: cwd)
 *     --root     the plugin root (default: this script's parent)
 *     --home     the home holding `.claude/` (tests; it also overrides CLAUDE_CONFIG_DIR)
 *     --json     `{ root, rows: [{ status, name, detail }] }` instead of the table
 *
 * Rows: node, platform (Windows only), manifest, hooks, scripts, slim, fnd, base-tmp. Every row is
 * one PASS / FAIL / SKIP / WARN line; the exit code is 1 if and only if a row FAILed. It reads
 * BASE_TMP_TTL (the age the session sweep removes base-tmp files at). It only reports, never repairs.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { baseTmpStats, parseTtl, SCRATCH_ROOT_REL } = require('./scratch-hygiene.cjs');

const MIN_NODE_MAJOR = 18;
// Plugin names the engine refuses to load a hooks module for (validate still passes).
const ENGINE_RESERVED = ['core', 'engine'];
const SLIM_INSTALL = 'claude plugin install slim@domaine';
const UNINSTALL_FND = 'claude plugin uninstall fnd@domaine';

const rows = [];
const report = (status, name, detail) => rows.push({ status, name, detail });
const pass = (n, d) => report('PASS', n, d);
const fail = (n, d) => report('FAIL', n, d);
const skip = (n, d) => report('SKIP', n, d);
const warn = (n, d) => report('WARN', n, d);

function out(line) {
  try {
    process.stdout.write(line + '\n');
  } catch (_) {}
}

const USAGE = 'usage: doctor.cjs [--project <dir>] [--root <plugin root>] [--home <dir>] [--json]\n';

function usage(msg) {
  if (!msg) {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  process.stderr.write('doctor: ' + msg + '\n' + USAGE);
  process.exit(2);
}

function parseArgs(argv) {
  const opts = { root: null, home: null, project: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') usage('');
    else if (a === '--json') opts.json = true;
    else if (a === '--root' || a === '--home' || a === '--project') {
      const v = argv[++i];
      if (!v || v.startsWith('--')) usage(a + ' needs a value');
      opts[a.slice(2)] = v;
    } else usage('unknown argument ' + a);
  }
  return opts;
}

function readJson(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch (_) {
    return null;
  }
}

function checkNode() {
  const major = Number(process.versions.node.split('.')[0]);
  const detail = 'node ' + process.versions.node + ' (>= ' + MIN_NODE_MAJOR + ' required)';
  if (Number.isFinite(major) && major >= MIN_NODE_MAJOR) pass('node', detail);
  else fail('node', detail);
}

// Windows has no POSIX shell for the fetchers and the git-hooks guard: one verdict, not one per script.
function checkPlatform() {
  if (process.platform !== 'win32') return;
  fail('platform', 'native Windows is unsupported — the scripts and the git-hooks guard need bash, git and curl: run Claude Code inside WSL');
}

function checkManifest(pluginRoot) {
  const rel = '.claude-plugin/plugin.json';
  let raw;
  try {
    raw = fs.readFileSync(path.join(pluginRoot, rel), 'utf8');
  } catch (e) {
    fail('manifest', rel + (e.code === 'ENOENT' ? ' missing — this is not a plugin root' : ' unreadable: ' + e.message));
    return;
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    fail('manifest', rel + ' invalid JSON: ' + e.message);
    return;
  }
  if (!data || typeof data !== 'object' || typeof data.version !== 'string' || !data.version) {
    fail('manifest', rel + ' has no "version" string');
    return;
  }
  if (ENGINE_RESERVED.includes(data.name)) {
    fail('manifest', rel + ' name "' + data.name + '" is the engine\'s own chain member: the hooks module never loads, so no guard, convention or command runs — rename the plugin');
    return;
  }
  const deps = Array.isArray(data.dependencies) ? data.dependencies : [];
  if (!deps.includes('slim')) {
    fail('manifest', rel + ' version ' + data.version + ' does not declare slim in "dependencies"');
    return;
  }
  pass('manifest', (data.name || 'plugin') + ' ' + data.version + ', depends on slim');
}

// The hooks module the engine loads: hooks/hooks.json's `modules`, each a file under hooks/.
function checkHooks(pluginRoot) {
  const file = path.join(pluginRoot, 'hooks', 'hooks.json');
  const data = readJson(file);
  if (!data) {
    fail('hooks', 'hooks/hooks.json missing or not a JSON object');
    return;
  }
  const mods = Array.isArray(data.modules) ? data.modules : [];
  if (!mods.length) {
    fail('hooks', 'hooks/hooks.json lists no modules');
    return;
  }
  const missing = mods.filter((m) => typeof m !== 'string' || !fs.existsSync(path.join(pluginRoot, 'hooks', m)));
  if (missing.length) fail('hooks', 'module(s) missing: ' + missing.map(String).join(', '));
  else pass('hooks', mods.length + ' module(s): ' + mods.join(', '));
}

// The agents and skills run the fetchers by path, so each needs its exec bit; `_common.sh` is sourced.
function checkScripts(pluginRoot) {
  const dir = path.join(pluginRoot, 'scripts');
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.sh') && !n.startsWith('_')).sort();
  } catch (e) {
    fail('scripts', 'scripts/ unreadable: ' + e.message);
    return;
  }
  if (process.platform === 'win32') {
    skip('scripts', 'no exec bits on Windows — see the platform row');
    return;
  }
  const offenders = names.filter((n) => {
    try {
      return !(fs.statSync(path.join(dir, n)).mode & 0o111);
    } catch (_) {
      return true;
    }
  });
  if (offenders.length) fail('scripts', offenders.join(', ') + ' not executable — chmod +x');
  else pass('scripts', names.length + ' shell script(s) executable');
}

/** User settings, then the project's shared and local settings: the later file wins per key. */
function enabledPlugins(claudeDir, projectDir) {
  const merged = {};
  for (const f of [
    path.join(claudeDir, 'settings.json'),
    path.join(projectDir, '.claude', 'settings.json'),
    path.join(projectDir, '.claude', 'settings.local.json'),
  ]) {
    const s = readJson(f);
    if (s && s.enabledPlugins && typeof s.enabledPlugins === 'object') Object.assign(merged, s.enabledPlugins);
  }
  return merged;
}

/** The install of `<name>@<marketplace>` this project would load (user scope or this project), or null. */
function installedPlugin(name, claudeDir, projectDir, enabled) {
  const record = readJson(path.join(claudeDir, 'plugins', 'installed_plugins.json'));
  const plugins = record && record.plugins && typeof record.plugins === 'object' ? record.plugins : {};
  let disabled = null;
  for (const [key, entries] of Object.entries(plugins)) {
    if (key.split('@')[0] !== name || !Array.isArray(entries)) continue;
    const entry = entries.find((e) => e && (e.scope === 'user' || (e.projectPath && path.resolve(e.projectPath) === projectDir)));
    if (!entry) continue;
    const found = { key, version: String(entry.version || '?') };
    if (enabled[key] === false) {
      disabled = found;
      continue;
    }
    return { ...found, disabled: false };
  }
  return disabled ? { ...disabled, disabled: true } : null;
}

function checkSlim(claudeDir, projectDir, enabled) {
  const slim = installedPlugin('slim', claudeDir, projectDir, enabled);
  if (!slim) fail('slim', 'not installed — base reads large results through it and refuses its readers without it: ' + SLIM_INSTALL);
  else if (slim.disabled) fail('slim', slim.key + ' ' + slim.version + ' is installed but disabled — enable it in /plugin');
  else pass('slim', slim.key + ' ' + slim.version + ' installed and enabled');
}

function checkFnd(claudeDir, projectDir, enabled) {
  const fnd = installedPlugin('fnd', claudeDir, projectDir, enabled);
  if (!fnd) pass('fnd', 'not installed');
  else if (fnd.disabled) warn('fnd', fnd.key + ' ' + fnd.version + ' is installed but disabled — uninstall it once the move to base is done: ' + UNINSTALL_FND);
  else fail('fnd', fnd.key + ' ' + fnd.version + ' is installed and enabled — fnd and base must not run together: ' + UNINSTALL_FND);
}

function kb(bytes) {
  return bytes < 1024 ? bytes + ' B' : bytes < 1048576 ? (bytes / 1024).toFixed(1) + ' KB' : (bytes / 1048576).toFixed(1) + ' MB';
}

function checkCoreTmp(projectDir) {
  const ttl = parseTtl(process.env.BASE_TMP_TTL);
  const st = baseTmpStats(projectDir, ttl);
  if (!st.present) {
    pass('base-tmp', SCRATCH_ROOT_REL + ' absent — nothing written there yet');
    return;
  }
  let detail = SCRATCH_ROOT_REL + ': ' + st.files + ' file(s), ' + kb(st.bytes);
  if (ttl > 0 && st.stale) detail += '; ' + st.stale + ' older than ' + ttl + ' h (the next session sweeps them)';
  if (ttl === 0) detail += '; the sweep is off (BASE_TMP_TTL=0)';
  const ci = spawnSync('git', ['check-ignore', '-q', SCRATCH_ROOT_REL], { cwd: projectDir, stdio: 'ignore', timeout: 2000 });
  if (ci.status === 1) {
    warn('base-tmp', detail + '; not ignored by git — the next guarded write or session sweep adds it to .git/info/exclude');
    return;
  }
  pass('base-tmp', detail + (ci.status === 0 ? '; ignored by git' : ''));
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const pluginRoot = path.resolve(opts.root || path.join(__dirname, '..'));
  const projectDir = path.resolve(opts.project || process.cwd());
  const homeDir = opts.home ? path.resolve(opts.home) : os.homedir();
  const claudeDir = !opts.home && process.env.CLAUDE_CONFIG_DIR ? path.resolve(process.env.CLAUDE_CONFIG_DIR) : path.join(homeDir, '.claude');
  const enabled = enabledPlugins(claudeDir, projectDir);

  checkNode();
  checkPlatform();
  checkManifest(pluginRoot);
  checkHooks(pluginRoot);
  checkScripts(pluginRoot);
  checkSlim(claudeDir, projectDir, enabled);
  checkFnd(claudeDir, projectDir, enabled);
  checkCoreTmp(projectDir);

  const failed = rows.some((r) => r.status === 'FAIL');
  if (opts.json) {
    out(JSON.stringify({ root: pluginRoot, rows }));
  } else {
    const width = rows.reduce((w, r) => Math.max(w, r.name.length), 0);
    out('base doctor — plugin root: ' + pluginRoot);
    for (const r of rows) out(r.status + '  ' + r.name.padEnd(width) + '  ' + r.detail);
    const counts = { PASS: 0, FAIL: 0, SKIP: 0, WARN: 0 };
    for (const r of rows) counts[r.status]++;
    out('doctor: ' + counts.PASS + ' passed, ' + counts.FAIL + ' failed, ' + counts.SKIP + ' skipped' +
      (counts.WARN ? ', ' + counts.WARN + ' warned' : ''));
  }
  // exitCode, not exit(): a piped stdout write can still be in flight when exit() tears the process down
  process.exitCode = failed ? 1 : 0;
}

main();
