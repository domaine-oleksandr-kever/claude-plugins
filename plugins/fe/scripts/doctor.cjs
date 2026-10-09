#!/usr/bin/env node
/*
 * doctor.cjs — fe's static install checks: what a node process can see without a session.
 *
 * No model, no network: files, exec bits, JSON, local probes. `/fe-doctor` (hooks/mods/doctor.ts) runs it
 * with --json and adds the rows only a session can answer (base's skills loaded, slim's view tool
 * registered, the profile the session decided). It also runs standalone.
 *
 * Usage:
 *   node doctor.cjs [--project <dir>] [--root <plugin root>] [--home <dir>] [--log-dir <dir>] [--json]
 *     --project  the project whose profile and store config are checked (default: cwd)
 *     --root     the plugin root (default: this script's parent)
 *     --home     the home holding `.claude/` (tests; it also overrides CLAUDE_CONFIG_DIR)
 *     --log-dir  the session's event-log directory (`/fe-doctor` passes its own); default: the newest
 *                session directory under DOMAINE_LOG_DIR, else under <home>/.claude/domaine/log
 *     --json     `{ root, rows: [{ status, name, detail }] }` instead of the table
 *
 * Rows: node, manifest, scripts, base, shopify-cli, profile, store-config, event-log. Every row is one
 * PASS / FAIL / SKIP / WARN line; the exit code is 1 if and only if a row FAILed. It reads FE_PROFILE
 * (through scripts/project-profile.sh too), FE_EVENT_LOG and DOMAINE_LOG_DIR. It never prints a value
 * from `.env` or `shopify.theme.toml`, and it only reports, never repairs.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const MIN_NODE_MAJOR = 18;
const BASE_INSTALL = 'claude plugin install base@domaine';
const PROFILES = ['foundation', 'theme', 'none'];
const STORE_FILES = ['shopify.theme.toml', '.env'];
// Its one argument is a directory, so `--help` is no probe for it: the profile row runs it instead.
const PROFILE_SCRIPT = 'project-profile.sh';

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

const USAGE = 'usage: doctor.cjs [--project <dir>] [--root <plugin root>] [--home <dir>] [--log-dir <dir>] [--json]\n';

function usage(msg) {
  if (!msg) {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  process.stderr.write('doctor: ' + msg + '\n' + USAGE);
  process.exit(2);
}

function parseArgs(argv) {
  const opts = { root: null, home: null, project: null, 'log-dir': null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') usage('');
    else if (a === '--json') opts.json = true;
    else if (a === '--root' || a === '--home' || a === '--project' || a === '--log-dir') {
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

const firstLine = (s) => String(s || '').trim().split('\n')[0].slice(0, 160);

function checkNode() {
  const major = Number(process.versions.node.split('.')[0]);
  const detail = 'node ' + process.versions.node + ' (>= ' + MIN_NODE_MAJOR + ' required)';
  if (Number.isFinite(major) && major >= MIN_NODE_MAJOR) pass('node', detail);
  else fail('node', detail);
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
  if (data.name !== 'fe') {
    fail('manifest', rel + ' name ' + JSON.stringify(data.name) + ' is not "fe" — the skills and the doctor answer to /fe:…');
    return;
  }
  const deps = Array.isArray(data.dependencies) ? data.dependencies : [];
  if (!deps.includes('base')) {
    fail('manifest', rel + ' version ' + data.version + ' does not declare base in "dependencies"');
    return;
  }
  pass('manifest', 'fe ' + data.version + ', depends on base');
}

// The skills run the scripts by path, so each needs its exec bit and must answer `--help`; `_*.sh` is sourced.
function checkScripts(pluginRoot) {
  const dir = path.join(pluginRoot, 'scripts');
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.sh') && !n.startsWith('_')).sort();
  } catch (e) {
    fail('scripts', 'scripts/ unreadable: ' + e.message);
    return;
  }
  if (!names.length) {
    fail('scripts', 'scripts/ holds no shell script');
    return;
  }
  if (process.platform === 'win32') {
    skip('scripts', 'no exec bits or bash on native Windows — run Claude Code inside WSL');
    return;
  }
  const problems = [];
  for (const n of names) {
    const file = path.join(dir, n);
    let mode = 0;
    try {
      mode = fs.statSync(file).mode;
    } catch (_) {}
    if (!(mode & 0o111)) {
      problems.push(n + ' not executable — chmod +x');
      continue;
    }
    if (n === PROFILE_SCRIPT) continue;
    const r = spawnSync('bash', [file, '--help'], { cwd: os.tmpdir(), stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000, encoding: 'utf8' });
    if (r.error) problems.push(n + ' --help did not run: ' + r.error.message);
    else if (r.status !== 0) problems.push(n + ' --help exited ' + r.status + (firstLine(r.stderr) ? ': ' + firstLine(r.stderr) : ''));
  }
  if (problems.length) fail('scripts', problems.join('; '));
  else pass('scripts', names.length + ' shell script(s) executable, each answers --help');
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

/**
 * The install of `<name>@<marketplace>` this project would load (user scope or this project), or null.
 * Enabled means its settings key is `true`: Claude Code never loads a plugin whose key is absent.
 */
function installedPlugin(name, claudeDir, projectDir, enabled) {
  const record = readJson(path.join(claudeDir, 'plugins', 'installed_plugins.json'));
  const plugins = record && record.plugins && typeof record.plugins === 'object' ? record.plugins : {};
  let disabled = null;
  for (const [key, entries] of Object.entries(plugins)) {
    if (key.split('@')[0] !== name || !Array.isArray(entries)) continue;
    const entry = entries.find((e) => e && (e.scope === 'user' || (e.projectPath && path.resolve(e.projectPath) === projectDir)));
    if (!entry) continue;
    const found = { key, version: String(entry.version || '?') };
    if (enabled[key] !== true) {
      disabled = found;
      continue;
    }
    return { ...found, disabled: false };
  }
  return disabled ? { ...disabled, disabled: true } : null;
}

function checkBase(claudeDir, projectDir, enabled) {
  const base = installedPlugin('base', claudeDir, projectDir, enabled);
  if (!base) fail('base', 'not installed — fe needs its readers, skills and MCP servers: ' + BASE_INSTALL);
  else if (base.disabled) fail('base', base.key + ' ' + base.version + ' is installed but disabled — enable it in /plugin');
  else pass('base', base.key + ' ' + base.version + ' installed and enabled');
}

// The theme scripts drive the Shopify CLI; fe still works without it for everything but the store.
function checkShopifyCli() {
  const r = spawnSync('shopify', ['version'], { cwd: os.tmpdir(), stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000, encoding: 'utf8' });
  if (r.error && r.error.code === 'ENOENT') {
    warn('shopify-cli', 'shopify is not on PATH — preview themes, theme-json.sh and the Admin runner need it: npm install -g @shopify/cli');
    return;
  }
  if (r.error || r.status !== 0) {
    warn('shopify-cli', 'shopify version ' + (r.error ? 'did not finish: ' + r.error.message : 'exited ' + r.status + (firstLine(r.stderr) ? ': ' + firstLine(r.stderr) : '')));
    return;
  }
  const v = (String(r.stdout).match(/\d+\.\d+\.\d+\S*/) || [firstLine(r.stdout) || '?'])[0];
  pass('shopify-cli', 'shopify ' + v);
}

/** The profile word and how it was decided, as the session decides it: FE_PROFILE, else the script. */
function checkProfile(pluginRoot, projectDir) {
  const forced = (process.env.FE_PROFILE || '').trim();
  if (PROFILES.includes(forced)) {
    pass('profile', forced + ' (FE_PROFILE)');
    return forced;
  }
  const script = path.join(pluginRoot, 'scripts', PROFILE_SCRIPT);
  if (!fs.existsSync(script)) {
    fail('profile', 'scripts/' + PROFILE_SCRIPT + ' missing — fe falls back to none');
    return 'none';
  }
  const r = spawnSync('bash', [script, projectDir], { cwd: projectDir, stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000, encoding: 'utf8' });
  const word = String(r.stdout || '').trim();
  if (!r.error && r.status === 0 && PROFILES.includes(word)) {
    pass('profile', word + ' (' + PROFILE_SCRIPT + ')');
    return word;
  }
  const why = r.error ? 'did not run: ' + r.error.message : 'exited ' + r.status + ': ' + (firstLine(r.stderr) || firstLine(word) || 'no answer');
  warn('profile', 'none (fallback: ' + PROFILE_SCRIPT + ' ' + why + ')');
  return 'none';
}

// Presence only: the runners read the store and the credentials from these files, never this doctor.
function checkStoreConfig(projectDir, profile) {
  const present = STORE_FILES.filter((f) => fs.existsSync(path.join(projectDir, f)));
  const absent = STORE_FILES.filter((f) => !present.includes(f));
  if (!absent.length) {
    pass('store-config', present.join(' and ') + ' present (values not read)');
    return;
  }
  if (!present.length && profile === 'none') {
    skip('store-config', 'not a theme checkout (profile none): no ' + STORE_FILES.join(' or ') + ' expected');
    return;
  }
  warn('store-config', absent.join(' and ') + ' absent in ' + projectDir +
    ' — the store runners and /fe:preview-theme read the store and its tokens from it' +
    (present.length ? '; ' + present.join(', ') + ' present (values not read)' : ''));
}

/** The session directory under `root` whose newest file is the newest, or null; a link is never followed. */
function newestSessionDir(root) {
  let best = null;
  let bestMs = -1;
  let names;
  try {
    names = fs.readdirSync(root);
  } catch (_) {
    return null;
  }
  for (const n of names) {
    const dir = path.join(root, n);
    try {
      const st = fs.lstatSync(dir);
      if (!st.isDirectory()) continue;
      let ms = st.mtimeMs;
      for (const f of fs.readdirSync(dir)) ms = Math.max(ms, fs.lstatSync(path.join(dir, f)).mtimeMs);
      if (ms > bestMs) {
        best = dir;
        bestMs = ms;
      }
    } catch (_) {}
  }
  return best;
}

// fe writes `<dir>/fe.jsonl` for the session beside base's, band's and slim's; base sweeps old directories.
function checkEventLog(logDir, homeDir) {
  const off = process.env.FE_EVENT_LOG === '0';
  let dir = logDir ? path.resolve(logDir) : null;
  if (!dir) {
    const override = (process.env.DOMAINE_LOG_DIR || '').trim();
    const root = path.isAbsolute(override) ? override : path.join(homeDir, '.claude', 'domaine', 'log');
    dir = newestSessionDir(root);
    if (!dir) {
      pass('event-log', root + ': no session directory yet' + (off ? "; fe's is off (FE_EVENT_LOG=0)" : ''));
      return;
    }
  }
  const file = path.join(dir, 'fe.jsonl');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (off) pass('event-log', dir + ": fe's is off (FE_EVENT_LOG=0)");
    // A /clear's new session has no line until its first event: nothing failed yet.
    else if (e.code === 'ENOENT') pass('event-log', dir + ': no fe.jsonl line yet this session');
    else warn('event-log', file + ' unreadable: ' + e.message);
    return;
  }
  const lines = text.split('\n').filter((l) => l.trim());
  let ts = 'none';
  if (lines.length) {
    try {
      ts = String(JSON.parse(lines[lines.length - 1]).ts || '?');
    } catch (_) {
      ts = 'unreadable';
    }
  }
  pass('event-log', file + ': ' + lines.length + ' line(s), newest ' + ts + (off ? "; fe's is off now (FE_EVENT_LOG=0)" : ''));
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const pluginRoot = path.resolve(opts.root || path.join(__dirname, '..'));
  const projectDir = path.resolve(opts.project || process.cwd());
  const homeDir = opts.home ? path.resolve(opts.home) : os.homedir();
  const claudeDir = !opts.home && process.env.CLAUDE_CONFIG_DIR ? path.resolve(process.env.CLAUDE_CONFIG_DIR) : path.join(homeDir, '.claude');

  checkNode();
  checkManifest(pluginRoot);
  checkScripts(pluginRoot);
  checkBase(claudeDir, projectDir, enabledPlugins(claudeDir, projectDir));
  checkShopifyCli();
  const profile = checkProfile(pluginRoot, projectDir);
  checkStoreConfig(projectDir, profile);
  checkEventLog(opts['log-dir'], homeDir);

  const failed = rows.some((r) => r.status === 'FAIL');
  if (opts.json) {
    out(JSON.stringify({ root: pluginRoot, rows }));
  } else {
    const width = rows.reduce((w, r) => Math.max(w, r.name.length), 0);
    out('fe doctor — plugin root: ' + pluginRoot);
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
