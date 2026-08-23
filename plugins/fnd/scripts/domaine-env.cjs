#!/usr/bin/env node
// domaine-env — read/write the Domaine env files that scripts/env-file.cjs loads into every
// fnd entry point (precedence: process env > project file > global file > default).
//
//   node domaine-env.cjs list             switches with their effective value and source
//   node domaine-env.cjs set KEY=VALUE    write into the global file (~/.config/domaine/env)
//   node domaine-env.cjs unset KEY        remove from the global file
//   node domaine-env.cjs path             print the target file path
//
// `--project` on set/unset/path targets `<git toplevel>/.claude/domaine.env` instead — the
// per-repository layer ("debug for this project only"). Writes preserve every comment and
// unrecognized line; only the first `KEY=` line is replaced or removed.
//
// What each switch means is documented once, in README.md → "Environment switches" — KNOWN
// below carries names only so `list` can show the unset ones (tests/readme-checks.sh keeps
// the two lists in sync).
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const envFile = require('./env-file.cjs');

const KNOWN = [
  'FND_LEAN',
  'FND_CTX_MONITOR',
  'FND_CTX_WARN',
  'FND_CTX_WINDOW',
  'FND_MCP_SLIM',
  'FND_MCP_SLIM_DIR',
  'FND_MCP_SLIM_TTL',
  'FND_MCP_SLIM_DEBUG',
  'FND_MCP_SLIM_STUB',
  'FND_MCP_SLIM_STUB_BYTES',
  'FND_MCP_SLIM_BUDGET_MS',
  'FND_WHALE_GUIDE',
  'FND_NOGAIN_MEMO',
  'FND_PROMPT_JSON',
  'FND_GQL_PROBE_CACHE',
  'FND_CPT_THROTTLE_WAITS',
  'SHOPIFY_ADMIN_GQL_QUIET',
];

function die(msg) {
  process.stderr.write('domaine-env: ' + msg + '\n');
  process.exit(1);
}

// The write target must be the repo the developer stands in, not some ancestor that happens to
// carry a `.claude/` — hence git toplevel, not the read-side walk-up.
function projectTarget() {
  let top;
  try {
    top = execSync('git rev-parse --show-toplevel', {
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim();
  } catch (_) {
    die('--project needs a git repository (run from inside the project)');
  }
  return path.join(top, '.claude', 'domaine.env');
}

function targetFile(project) {
  return project ? projectTarget() : envFile.globalPath();
}

function readLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/);
  } catch (_) {
    return [];
  }
}

function writeLines(file, lines) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  fs.writeFileSync(file, lines.length ? lines.join('\n') + '\n' : '');
}

function cmdSet(pair, project) {
  const eq = (pair || '').indexOf('=');
  if (eq < 1) die('set expects KEY=VALUE');
  const key = pair.slice(0, eq).trim();
  const value = pair.slice(eq + 1).trim();
  if (!envFile.allowed(key)) die('"' + key + '" is not an fnd switch (FND_* only)');
  const file = targetFile(project);
  const lines = readLines(file);
  const at = lines.findIndex((l) => l.trim().startsWith(key + '='));
  if (at >= 0) lines[at] = key + '=' + value;
  else lines.push(key + '=' + value);
  writeLines(file, lines);
  process.stdout.write(key + '=' + value + ' -> ' + file + '\n');
}

function cmdUnset(key, project) {
  if (!key) die('unset expects KEY');
  const file = targetFile(project);
  const lines = readLines(file);
  const kept = lines.filter((l) => !l.trim().startsWith(key + '='));
  if (kept.length === lines.length) die('"' + key + '" is not set in ' + file);
  writeLines(file, kept);
  process.stdout.write(key + ' removed from ' + file + '\n');
}

function cmdList() {
  const project = envFile.projectPath(process.cwd());
  const global = envFile.globalPath();
  const projVals = envFile.readVals(project);
  const globVals = envFile.readVals(global);
  process.stdout.write('precedence: process env > project file > global file > default\n');
  process.stdout.write('project: ' + (project || '<repo>/.claude/domaine.env (absent)') + '\n');
  process.stdout.write('global:  ' + global + (fs.existsSync(global) ? '' : ' (absent)') + '\n\n');
  const keys = [...new Set([...KNOWN, ...Object.keys(projVals), ...Object.keys(globVals)])];
  for (const key of keys) {
    let value, source;
    if (process.env[key] !== undefined) [value, source] = [process.env[key], 'process env'];
    else if (key in projVals) [value, source] = [projVals[key], 'project file'];
    else if (key in globVals) [value, source] = [globVals[key], 'global file'];
    else [value, source] = ['', 'default'];
    const cell = source === 'default' ? '(default — see README "Environment switches")'
      : '= ' + value + '   (' + source + ')';
    process.stdout.write(key.padEnd(24) + ' ' + cell + '\n');
  }
}

const args = process.argv.slice(2);
const project = args.includes('--project');
const rest = args.filter((a) => a !== '--project');
const cmd = rest[0] || 'list';

if (cmd === 'list') cmdList();
else if (cmd === 'set') cmdSet(rest[1], project);
else if (cmd === 'unset') cmdUnset(rest[1], project);
else if (cmd === 'path') process.stdout.write(targetFile(project) + '\n');
else die('unknown command "' + cmd + '" (list | set KEY=VALUE | unset KEY | path; --project)');
