#!/usr/bin/env node
/*
 * doctor.cjs — be's static install checks: what a node process can see without a session.
 *
 * No model, no network: files, exec bits, JSON. `/be-doctor` (hooks/mods/doctor.ts) runs it with --json and
 * adds the rows only a session can answer (base's skills loaded, slim's view tool registered). It also runs
 * standalone.
 *
 * Usage:
 *   node doctor.cjs [--project <dir>] [--root <be root>] [--home <dir>] [--log-dir <dir>] [--json]
 *     --project  the project whose settings may enable or disable base (default: cwd)
 *     --root     the plugin root (default: this script's parent)
 *     --home     the home holding `.claude/` (tests; it also overrides CLAUDE_CONFIG_DIR)
 *     --log-dir  the session's event-log directory (`/be-doctor` passes its own); default: the newest
 *                session directory under DOMAINE_LOG_DIR, else under <home>/.claude/domaine/log
 *     --json     `{ root, rows: [{ status, name, detail }] }` instead of the table
 *
 * Rows: node, manifest, scripts, base, shopify-dev-mcp, event-log. Every row is one PASS / FAIL / SKIP / WARN
 * line; the exit code is 1 if and only if a row FAILed. It reads BE_EVENT_LOG and DOMAINE_LOG_DIR. It only
 * reports, never repairs.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const MIN_NODE_MAJOR = 18;
const BASE_INSTALL = 'claude plugin install base@domaine';
const DEV_MCP = 'shopify-dev-mcp';

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

const USAGE = 'usage: doctor.cjs [--project <dir>] [--root <be root>] [--home <dir>] [--log-dir <dir>] [--json]\n';

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
  if (data.name !== 'be') {
    fail('manifest', rel + ' name ' + JSON.stringify(data.name) + ' is not "be" — the skills and the doctor answer to /be:…');
    return;
  }
  const deps = Array.isArray(data.dependencies) ? data.dependencies : [];
  if (!deps.includes('base')) {
    fail('manifest', rel + ' version ' + data.version + ' does not declare base in "dependencies"');
    return;
  }
  pass('manifest', 'be ' + data.version + ', depends on base');
}

// A `.sh` is run by path, so it keeps its exec bit (a sourced `_*.sh` need not); a `.cjs` has to parse.
function checkScripts(pluginRoot) {
  const dir = path.join(pluginRoot, 'scripts');
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.sh') || n.endsWith('.cjs')).sort();
  } catch (e) {
    fail('scripts', 'scripts/ unreadable: ' + e.message);
    return;
  }
  if (!names.length) {
    fail('scripts', 'scripts/ holds no script');
    return;
  }
  if (process.platform === 'win32') {
    skip('scripts', 'no exec bits or bash on native Windows — run Claude Code inside WSL');
    return;
  }
  const problems = [];
  for (const n of names) {
    const file = path.join(dir, n);
    if (n.endsWith('.sh')) {
      if (n.startsWith('_')) continue;
      let mode = 0;
      try {
        mode = fs.statSync(file).mode;
      } catch (_) {}
      if (!(mode & 0o111)) problems.push(n + ' not executable — chmod +x');
      continue;
    }
    const r = spawnSync(process.execPath, ['--check', file], { cwd: os.tmpdir(), stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000, encoding: 'utf8' });
    if (r.error) problems.push(n + ' --check did not run: ' + r.error.message);
    else if (r.status !== 0) problems.push(n + ' does not parse: ' + (firstLine(String(r.stderr).split('\n').filter((l) => /Error/.test(l)).join('\n')) || 'node --check exited ' + r.status));
  }
  if (problems.length) fail('scripts', problems.join('; '));
  else pass('scripts', names.length + ' script(s): every .sh executable, every .cjs parses');
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
    const found = { key, version: String(entry.version || '?'), installPath: typeof entry.installPath === 'string' ? entry.installPath : '' };
    if (enabled[key] === false) {
      disabled = found;
      continue;
    }
    return { ...found, disabled: false };
  }
  return disabled ? { ...disabled, disabled: true } : null;
}

function checkBase(base) {
  if (!base) fail('base', 'not installed — be needs its readers, writer and MCP servers: ' + BASE_INSTALL);
  else if (base.disabled) fail('base', base.key + ' ' + base.version + ' is installed but disabled — enable it in /plugin');
  else pass('base', base.key + ' ' + base.version + ' installed and enabled');
}

// The skills check API facts and current limits through base's Shopify Dev MCP server; be declares none itself.
function checkDevMcp(base) {
  if (!base || base.disabled) {
    skip(DEV_MCP, 'no enabled base install to read — the base row says why');
    return;
  }
  const file = path.join(base.installPath, '.claude-plugin', 'plugin.json');
  const manifest = base.installPath ? readJson(file) : null;
  if (!manifest) {
    fail(DEV_MCP, "base's manifest unreadable" + (base.installPath ? ' at ' + file : ' (no installPath in installed_plugins.json)') + ' — reinstall base');
    return;
  }
  const servers = manifest.mcpServers && typeof manifest.mcpServers === 'object' ? manifest.mcpServers : {};
  if (Object.prototype.hasOwnProperty.call(servers, DEV_MCP)) pass(DEV_MCP, "base's manifest declares " + DEV_MCP);
  else fail(DEV_MCP, "base's manifest (" + base.key + ' ' + base.version + ') declares no ' + DEV_MCP + ' — the skills verify API facts and limits through it');
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

// be writes `<dir>/be.jsonl` for the session beside the other Domaine plugins'; base sweeps old directories.
function checkEventLog(logDir, homeDir) {
  const off = process.env.BE_EVENT_LOG === '0';
  let dir = logDir ? path.resolve(logDir) : null;
  if (!dir) {
    const override = (process.env.DOMAINE_LOG_DIR || '').trim();
    const root = path.isAbsolute(override) ? override : path.join(homeDir, '.claude', 'domaine', 'log');
    dir = newestSessionDir(root);
    if (!dir) {
      pass('event-log', root + ': no session directory yet' + (off ? "; be's is off (BE_EVENT_LOG=0)" : ''));
      return;
    }
  }
  const file = path.join(dir, 'be.jsonl');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (off) pass('event-log', dir + ": be's is off (BE_EVENT_LOG=0)");
    // A /clear's new session has no line until its first event: nothing failed yet.
    else if (e.code === 'ENOENT') pass('event-log', dir + ': no be.jsonl line yet this session');
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
  pass('event-log', file + ': ' + lines.length + ' line(s), newest ' + ts + (off ? "; be's is off now (BE_EVENT_LOG=0)" : ''));
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
  checkDevMcp(base);
  checkEventLog(opts['log-dir'], homeDir);

  const failed = rows.some((r) => r.status === 'FAIL');
  if (opts.json) {
    out(JSON.stringify({ root: pluginRoot, rows }));
  } else {
    const width = rows.reduce((w, r) => Math.max(w, r.name.length), 0);
    out('be doctor — plugin root: ' + pluginRoot);
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
