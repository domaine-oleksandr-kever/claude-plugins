#!/usr/bin/env node
/*
 * doctor.cjs — qa's static install checks: what a node process can see without a session.
 *
 * No model, no network: files, exec bits, JSON, local probes. `/qa-doctor` (hooks/mods/doctor.ts) runs it
 * with --json and adds the rows only a session can answer (base's skills loaded, slim's view tool
 * registered). It also runs standalone.
 *
 * Usage:
 *   node doctor.cjs [--project <dir>] [--root <qa root>] [--home <dir>] [--log-dir <dir>] [--json]
 *     --project  the project whose settings may enable or disable base (default: cwd)
 *     --root     the plugin root (default: this script's parent)
 *     --home     the home holding `.claude/` and `.config/domaine/` (tests; it also overrides
 *                CLAUDE_CONFIG_DIR)
 *     --log-dir  the session's event-log directory (`/qa-doctor` passes its own); default: the newest
 *                session directory under DOMAINE_LOG_DIR, else under <home>/.claude/domaine/log
 *     --json     `{ root, rows: [{ status, name, detail }] }` instead of the table
 *
 * Rows: node, manifest, scripts, base, registry, gh, chrome-devtools, event-log. Every row is one
 * PASS / FAIL / SKIP / WARN line; the exit code is 1 if and only if a row FAILed. It reads QA_EVENT_LOG
 * and DOMAINE_LOG_DIR. The registry row runs base's `qa-stores.cjs path` and `list --json` (passwords
 * masked) and prints a store count only, never a store, a password or the registry's own error text. It
 * only reports, never repairs.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const MIN_NODE_MAJOR = 18;
const BASE_INSTALL = 'claude plugin install base@domaine';
const REGISTRY_SCRIPT = path.join('scripts', 'qa-stores.cjs');
const BROWSER_SERVER = 'chrome-devtools-mcp';

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

const USAGE = 'usage: doctor.cjs [--project <dir>] [--root <qa root>] [--home <dir>] [--log-dir <dir>] [--json]\n';

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
  if (data.name !== 'qa') {
    fail('manifest', rel + ' name ' + JSON.stringify(data.name) + ' is not "qa" — the skill and the doctor answer to /qa:…');
    return;
  }
  const deps = Array.isArray(data.dependencies) ? data.dependencies : [];
  if (!deps.includes('base')) {
    fail('manifest', rel + ' version ' + data.version + ' does not declare base in "dependencies"');
    return;
  }
  pass('manifest', 'qa ' + data.version + ', depends on base');
}

// Every file under scripts/ resolves; a `.sh` keeps its exec bit (`_*.sh` is sourced) and a `.cjs` parses.
function checkScripts(pluginRoot) {
  const dir = path.join(pluginRoot, 'scripts');
  let names;
  try {
    names = fs.readdirSync(dir).sort();
  } catch (e) {
    fail('scripts', 'scripts/ unreadable: ' + e.message);
    return;
  }
  const problems = [];
  let count = 0;
  for (const n of names) {
    const file = path.join(dir, n);
    let st;
    try {
      st = fs.statSync(file);
    } catch (_) {
      problems.push(n + ' missing (a dangling link?)');
      continue;
    }
    if (!st.isFile()) continue;
    count++;
    if (n.endsWith('.sh') && !n.startsWith('_')) {
      if (process.platform === 'win32') continue;
      if (!(st.mode & 0o111)) problems.push(n + ' not executable — chmod +x');
    } else if (n.endsWith('.cjs')) {
      const r = spawnSync(process.execPath, ['--check', file], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000, encoding: 'utf8' });
      if (r.error) problems.push(n + ' --check did not run: ' + r.error.message);
      else if (r.status !== 0) {
        const why = String(r.stderr || '').split('\n').find((l) => /Error/.test(l)) || firstLine(r.stderr);
        problems.push(n + ' does not parse: ' + why.trim().slice(0, 160));
      }
    }
  }
  if (problems.length) fail('scripts', problems.join('; '));
  else if (!count) fail('scripts', 'scripts/ holds no script');
  else pass('scripts', count + ' script(s): every .sh executable, every .cjs parses');
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
 * The install of `<name>@<marketplace>` this project would load (user scope or this project), else its synced copy, or null.
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
    const found = {
      key,
      version: String(entry.version || '?'),
      installPath: typeof entry.installPath === 'string' && entry.installPath ? path.resolve(entry.installPath) : null,
    };
    if (enabled[key] !== true) {
      disabled = found;
      continue;
    }
    return { ...found, disabled: false };
  }
  return disabled ? { ...disabled, disabled: true } : syncedPlugin(name, claudeDir, enabled);
}

/**
 * The claude.ai-account copy of `<name>` (`<name>@synced`): `plugins/synced/<account>/<name>/` beside this plugin
 * in a cloud session or a synced terminal, with no install record; it loads unless its settings key is `false`.
 */
function syncedPlugin(name, claudeDir, enabled) {
  const root = path.join(claudeDir, 'plugins', 'synced');
  let accounts = [];
  try { accounts = fs.readdirSync(root); } catch { return null; }
  for (const account of accounts) {
    const dir = path.resolve(root, account, name);
    const manifest = readJson(path.join(dir, '.claude-plugin', 'plugin.json'));
    if (!manifest) continue;
    const key = name + '@synced';
    return { key, version: String(manifest.version || '?'), installPath: dir, disabled: enabled[key] === false };
  }
  return null;
}

function checkBase(base) {
  if (!base) fail('base', 'not installed — qa needs its readers, its Jira writer, its QA store registry and its MCP servers: ' + BASE_INSTALL);
  else if (base.disabled) fail('base', base.key + ' ' + base.version + ' is installed but disabled — enable it in /plugin');
  else pass('base', base.key + ' ' + base.version + ' installed and enabled');
}

/** base's install directory when the base row passed, else null with the reason already given there. */
const baseRoot = (base) => (base && !base.disabled ? base.installPath : null);

// The registry is base's script and one file per machine; this row counts stores, it never shows one.
function checkRegistry(base, homeDir) {
  const root = baseRoot(base);
  if (!base || base.disabled) {
    skip('registry', "base is not installed and enabled (the base row): the registry is base's " + REGISTRY_SCRIPT);
    return;
  }
  if (!root) {
    skip('registry', base.key + ' has no installPath in installed_plugins.json');
    return;
  }
  const script = path.join(root, REGISTRY_SCRIPT);
  if (!fs.existsSync(script)) {
    fail('registry', script + ' missing — base ' + base.version + ' has no QA store registry; update base');
    return;
  }
  const run = (args) => spawnSync(process.execPath, [script, ...args], {
    cwd: os.tmpdir(),
    env: { ...process.env, HOME: homeDir },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10000,
    encoding: 'utf8',
  });
  const where = run(['path']);
  const file = where.status === 0 ? firstLine(where.stdout) : '';
  if (!file) {
    fail('registry', 'qa-stores.cjs path ' + (where.error ? 'did not run: ' + where.error.message : 'exited ' + where.status));
    return;
  }
  if (!fs.existsSync(file)) {
    skip('registry', 'no registry yet: qa-stores.cjs set <domain> --alias <a> --password <p> (' + file + ')');
    return;
  }
  const r = run(['list', '--json']);
  if (r.error) {
    fail('registry', 'qa-stores.cjs list did not run: ' + r.error.message);
    return;
  }
  if (r.status === 3) {
    fail('registry', file + ' is unreadable or corrupt — run qa-stores.cjs list to see why; nothing was written');
    return;
  }
  let stores = null;
  try {
    stores = JSON.parse(r.stdout);
  } catch (_) {}
  if (r.status !== 0 || !Array.isArray(stores)) {
    fail('registry', 'qa-stores.cjs list --json exited ' + r.status + ' without a store list');
    return;
  }
  pass('registry', file + ': ' + stores.length + ' store(s) registered');
}

// PR facts come from local gh; without it the skill falls back to the ticket's links.
function checkGh() {
  const r = spawnSync('gh', ['--version'], { cwd: os.tmpdir(), stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000, encoding: 'utf8' });
  if (r.error && r.error.code === 'ENOENT') {
    warn('gh', "gh is not on PATH — PR facts fall back to the ticket's links: https://cli.github.com");
    return;
  }
  if (r.error || r.status !== 0) {
    warn('gh', 'gh --version ' + (r.error ? 'did not finish: ' + r.error.message : 'exited ' + r.status + (firstLine(r.stderr) ? ': ' + firstLine(r.stderr) : '')));
    return;
  }
  const v = (String(r.stdout).match(/\d+\.\d+\.\d+\S*/) || [firstLine(r.stdout) || '?'])[0];
  pass('gh', 'gh ' + v);
}

// The browser phases drive base's chrome-devtools server; qa declares no server of its own.
function checkBrowserServer(base) {
  const root = baseRoot(base);
  if (!root) {
    skip('chrome-devtools', "base's install directory is unknown (the base row): its manifest declares the browser server");
    return;
  }
  const manifest = readJson(path.join(root, '.claude-plugin', 'plugin.json'));
  if (!manifest) {
    fail('chrome-devtools', path.join(root, '.claude-plugin', 'plugin.json') + ' unreadable or not a JSON object');
    return;
  }
  const servers = manifest.mcpServers && typeof manifest.mcpServers === 'object' ? manifest.mcpServers : {};
  if (Object.prototype.hasOwnProperty.call(servers, BROWSER_SERVER)) pass('chrome-devtools', 'base ' + base.version + ' declares ' + BROWSER_SERVER);
  else fail('chrome-devtools', 'base ' + base.version + ' declares no ' + BROWSER_SERVER + ' server — the unlock, the gate and the rows need it; update base');
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

// qa writes `<dir>/qa.jsonl` for the session beside base's, band's and slim's; base sweeps old directories.
function checkEventLog(logDir, homeDir) {
  const off = process.env.QA_EVENT_LOG === '0';
  let dir = logDir ? path.resolve(logDir) : null;
  if (!dir) {
    const override = (process.env.DOMAINE_LOG_DIR || '').trim();
    const root = path.isAbsolute(override) ? override : path.join(homeDir, '.claude', 'domaine', 'log');
    dir = newestSessionDir(root);
    if (!dir) {
      pass('event-log', root + ': no session directory yet' + (off ? "; qa's is off (QA_EVENT_LOG=0)" : ''));
      return;
    }
  }
  const file = path.join(dir, 'qa.jsonl');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (off) pass('event-log', dir + ": qa's is off (QA_EVENT_LOG=0)");
    // A /clear's new session has no line until its first event: nothing failed yet.
    else if (e.code === 'ENOENT') pass('event-log', dir + ': no qa.jsonl line yet this session');
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
  pass('event-log', file + ': ' + lines.length + ' line(s), newest ' + ts + (off ? "; qa's is off now (QA_EVENT_LOG=0)" : ''));
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
  const base = installedPlugin('base', claudeDir, projectDir, enabledPlugins(claudeDir, projectDir));
  checkBase(base);
  checkRegistry(base, homeDir);
  checkGh();
  checkBrowserServer(base);
  checkEventLog(opts['log-dir'], homeDir);

  const failed = rows.some((r) => r.status === 'FAIL');
  if (opts.json) {
    out(JSON.stringify({ root: pluginRoot, rows }));
  } else {
    const width = rows.reduce((w, r) => Math.max(w, r.name.length), 0);
    out('qa doctor — plugin root: ' + pluginRoot);
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
