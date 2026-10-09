#!/usr/bin/env node
/*
 * doctor.cjs — pm's static install checks: what a node process can see without a session.
 *
 * No model, no network: files, exec bits, JSON. `/pm-doctor` (hooks/mods/doctor.ts) runs it with --json and
 * adds the rows only a session can answer (base's skills loaded, slim's view tool registered). It also runs
 * standalone.
 *
 * Usage:
 *   node doctor.cjs [--project <dir>] [--root <dir>] [--home <dir>] [--log-dir <dir>] [--json]
 *     --project  the project whose settings may enable or disable base (default: cwd)
 *     --root     pm's plugin root (default: this script's parent)
 *     --home     the home holding `.claude/` (tests; it also overrides CLAUDE_CONFIG_DIR)
 *     --log-dir  the session's event-log directory (`/pm-doctor` passes its own); default: the newest
 *                session directory under DOMAINE_LOG_DIR, else under <home>/.claude/domaine/log
 *     --json     `{ root, rows: [{ status, name, detail }] }` instead of the table
 *
 * Rows: node, manifest, scripts, base, atlassian, notion-mcp, event-log. Every row is one PASS / FAIL / SKIP /
 * WARN line; the exit code is 1 if and only if a row FAILed. It reads PM_EVENT_LOG and DOMAINE_LOG_DIR. It
 * reads no secret, and it only reports, never repairs.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');
const { spawnSync } = require('child_process');

const MIN_NODE_MAJOR = 18;
const BASE_INSTALL = 'claude plugin install base@domaine';
// The servers pm's skills reach through base: Jira and Confluence, and Notion.
const BASE_SERVERS = ['atlassian', 'notion-mcp'];

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

const USAGE = 'usage: doctor.cjs [--project <dir>] [--root <dir>] [--home <dir>] [--log-dir <dir>] [--json]\n';

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
  if (data.name !== 'pm') {
    fail('manifest', rel + ' name ' + JSON.stringify(data.name) + ' is not "pm" — the skills and the doctor answer to /pm:…');
    return;
  }
  const deps = Array.isArray(data.dependencies) ? data.dependencies : [];
  if (!deps.includes('base')) {
    fail('manifest', rel + ' version ' + data.version + ' does not declare base in "dependencies"');
    return;
  }
  pass('manifest', 'pm ' + data.version + ', depends on base');
}

/** null when `file` compiles as a CommonJS module (wrapped as node wraps it, shebang dropped), else why not. */
function parseError(file) {
  try {
    const src = fs.readFileSync(file, 'utf8').replace(/^#!.*/, '');
    new vm.Script('(function (exports, require, module, __filename, __dirname) {' + src + '\n})', { filename: file });
    return null;
  } catch (e) {
    return firstLine((e && e.name ? e.name + ': ' : '') + (e && e.message ? e.message : String(e)));
  }
}

// A `.sh` runs by path, so it needs its exec bit and must answer `--help` (`_*.sh` is sourced); a `.cjs` must parse.
function checkScripts(pluginRoot) {
  const dir = path.join(pluginRoot, 'scripts');
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => !n.startsWith('.')).sort();
  } catch (e) {
    fail('scripts', 'scripts/ unreadable: ' + e.message);
    return;
  }
  if (!names.length) {
    fail('scripts', 'scripts/ is empty — doctor.cjs belongs there');
    return;
  }
  const problems = [];
  const win = process.platform === 'win32';
  let cjs = 0;
  let sh = 0;
  let unprobed = 0;
  for (const n of names) {
    const file = path.join(dir, n);
    if (n.endsWith('.cjs')) {
      cjs++;
      const why = parseError(file);
      if (why) problems.push(n + ' does not parse: ' + why);
    } else if (n.endsWith('.sh') && !n.startsWith('_')) {
      sh++;
      if (win) {
        unprobed++;
        continue;
      }
      let mode = 0;
      try {
        mode = fs.statSync(file).mode;
      } catch (_) {}
      if (!(mode & 0o111)) {
        problems.push(n + ' not executable — chmod +x');
        continue;
      }
      const r = spawnSync('bash', [file, '--help'], { cwd: os.tmpdir(), stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000, encoding: 'utf8' });
      if (r.error) problems.push(n + ' --help did not run: ' + r.error.message);
      else if (r.status !== 0) problems.push(n + ' --help exited ' + r.status + (firstLine(r.stderr) ? ': ' + firstLine(r.stderr) : ''));
    }
  }
  if (problems.length) {
    fail('scripts', problems.join('; '));
    return;
  }
  const parts = [cjs + ' .cjs parse'];
  if (unprobed) parts.push(unprobed + ' .sh not probed — no exec bits or bash on native Windows');
  else if (sh) parts.push(sh + ' .sh executable, each answers --help');
  pass('scripts', parts.join('; '));
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
  if (!base) fail('base', 'not installed — pm needs its readers, its Jira writer and its MCP servers: ' + BASE_INSTALL);
  else if (base.disabled) fail('base', base.key + ' ' + base.version + ' is installed but disabled — enable it in /plugin');
  else pass('base', base.key + ' ' + base.version + ' installed and enabled');
}

// pm declares no MCP server: Jira, Confluence and Notion come from base's manifest, read at its install path.
function checkBaseServers(base) {
  if (!base || base.disabled) {
    for (const s of BASE_SERVERS) skip(s, 'no enabled base install to read — the base row says why');
    return;
  }
  const file = path.join(base.installPath, '.claude-plugin', 'plugin.json');
  const manifest = base.installPath ? readJson(file) : null;
  if (!manifest) {
    const where = base.installPath ? ' at ' + file : ' (no installPath in installed_plugins.json)';
    for (const s of BASE_SERVERS) fail(s, "base's manifest unreadable" + where + ' — reinstall base');
    return;
  }
  const declared = manifest.mcpServers && typeof manifest.mcpServers === 'object' ? manifest.mcpServers : {};
  for (const s of BASE_SERVERS) {
    if (Object.prototype.hasOwnProperty.call(declared, s)) pass(s, "declared in base's manifest (" + base.key + ' ' + base.version + ')');
    else fail(s, "not declared in base's manifest (" + base.key + ' ' + base.version + ') — pm reaches it only through base: update base');
  }
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

// pm writes `<dir>/pm.jsonl` for the session beside base's, band's and slim's; base sweeps old directories.
function checkEventLog(logDir, homeDir) {
  const off = process.env.PM_EVENT_LOG === '0';
  let dir = logDir ? path.resolve(logDir) : null;
  if (!dir) {
    const override = (process.env.DOMAINE_LOG_DIR || '').trim();
    const root = path.isAbsolute(override) ? override : path.join(homeDir, '.claude', 'domaine', 'log');
    dir = newestSessionDir(root);
    if (!dir) {
      pass('event-log', root + ': no session directory yet' + (off ? "; pm's is off (PM_EVENT_LOG=0)" : ''));
      return;
    }
  }
  const file = path.join(dir, 'pm.jsonl');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (off) pass('event-log', dir + ": pm's is off (PM_EVENT_LOG=0)");
    // A /clear's new session has no line until its first event: nothing failed yet.
    else if (e.code === 'ENOENT') pass('event-log', dir + ': no pm.jsonl line yet this session');
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
  pass('event-log', file + ': ' + lines.length + ' line(s), newest ' + ts + (off ? "; pm's is off now (PM_EVENT_LOG=0)" : ''));
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
  checkBaseServers(base);
  checkEventLog(opts['log-dir'], homeDir);

  const failed = rows.some((r) => r.status === 'FAIL');
  if (opts.json) {
    out(JSON.stringify({ root: pluginRoot, rows }));
  } else {
    const width = rows.reduce((w, r) => Math.max(w, r.name.length), 0);
    out('pm doctor — plugin root: ' + pluginRoot);
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
