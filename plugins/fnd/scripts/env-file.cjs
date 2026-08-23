// Domaine env files — the host-independent home for the FND_* switches. Cursor, Codex and
// OpenCode have no per-plugin env block and GUI apps don't inherit shell profiles, so every
// fnd Node entry point calls load() first and reads switches from process.env as before.
//
//   precedence  process env  >  <repo>/.claude/domaine.env  >  ~/.config/domaine/env  >  default
//               (load() fills gaps only — a value already in the environment is never touched)
//   format      KEY=VALUE, one per line; `#` full-line comments and blank lines; value is
//               everything after the first `=`, trimmed. No quoting, no $VAR expansion, no
//               multiline — the dialect is defined here, not by any dotenv implementation.
//   allowlist   FND_* plus the named extras. Anything else is ignored so the file can never
//               smuggle PATH / NODE_OPTIONS / LD_PRELOAD into every hook.
//
// Malformed lines are skipped silently: hooks must never die on a bad config file. The
// `domaine-env` CLI (scripts/domaine-env.cjs) reads, writes and lists these files.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ALLOW_EXTRA = new Set(['SHOPIFY_ADMIN_GQL_QUIET']);

function allowed(key) {
  return /^FND_[A-Z0-9_]+$/.test(key) || ALLOW_EXTRA.has(key);
}

function globalPath() {
  if (process.platform === 'win32' && process.env.APPDATA) {
    return path.join(process.env.APPDATA, 'domaine', 'env');
  }
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'domaine', 'env');
}

// Nearest `.claude/domaine.env` walking up from cwd (hooks may run in a subdirectory of the
// repo). Null when none exists — load() then simply has no project layer.
function projectPath(cwd) {
  let dir = path.resolve(cwd || process.cwd());
  for (let i = 0; i < 50; i++) {
    const p = path.join(dir, '.claude', 'domaine.env');
    try {
      if (fs.existsSync(p)) return p;
    } catch (_) {
      return null;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

function parse(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    if (!allowed(key)) continue;
    if (!(key in out)) out[key] = line.slice(eq + 1).trim();
  }
  return out;
}

function readVals(file) {
  if (!file) return {};
  try {
    return parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return {};
  }
}

// Fills process.env gaps from the project file, then the global file. Returns what it applied
// (only file-sourced values — the Cursor sessionStart hook forwards exactly that set) and the
// file paths involved. Never throws.
function load(cwd) {
  const files = { project: projectPath(cwd), global: globalPath() };
  const applied = {};
  for (const layer of [readVals(files.project), readVals(files.global)]) {
    for (const key of Object.keys(layer)) {
      if (process.env[key] === undefined && !(key in applied)) applied[key] = layer[key];
    }
  }
  for (const key of Object.keys(applied)) process.env[key] = applied[key];
  return { applied, files };
}

module.exports = { load, parse, readVals, projectPath, globalPath, allowed };
