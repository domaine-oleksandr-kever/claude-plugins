#!/usr/bin/env node
/*
 * conventions.cjs — qa's conventions as a Claude Code command hook (hooks/hooks.json), the one channel that
 * reaches the model on every login. Text: conventions-text.json. Mode (argv):
 *   start  SessionStart: the root line and the storefront-passwords section
 * qa adds nothing to subagents. start writes the marker <log dir>/<session>/conventions.qa.json, which base's
 * doctor and the mod's cloud fallback read. Always exits 0; an internal error prints nothing.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const P = 'qa';
const ROOT = (process.env.CLAUDE_PLUGIN_ROOT || '').replace(/\/+$/, '') || path.resolve(__dirname, '..');

function readStdin() {
  try {
    const buf = Buffer.alloc(1 << 20);
    let n = 0;
    let r;
    while (n < buf.length && (r = fs.readSync(0, buf, n, buf.length - n, null)) > 0) n += r;
    const v = JSON.parse(buf.toString('utf8', 0, n));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

function readJson(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

const envelope = (event, text) => JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } });
const abs = (p) => ((p || '').trim().startsWith('/') ? p.trim().replace(/\/+$/, '') : '');

/**
 * `<DOMAINE_LOG_DIR>/<session>`, else `$HOME/.claude/domaine/log/<session>`; with `spare`, `<TMPDIR or /tmp>/domaine-log/<session>`.
 * null for a bad id or no root.
 */
function logDir(sid, spare) {
  if (typeof sid !== 'string' || !/^[\w.-]+$/.test(sid) || /^\.+$/.test(sid)) return null;
  const home = abs(process.env.HOME);
  const root = spare ? (abs(process.env.TMPDIR) || '/tmp') + '/domaine-log' : abs(process.env.DOMAINE_LOG_DIR) || (home && home + '/.claude/domaine/log');
  return root ? root + '/' + sid : null;
}

/** The log dir, else the spare dir: printed context always leaves a marker the mods' fallback sees. */
function writeMarker(sid, name, data) {
  let why = null;
  for (const dir of [logDir(sid), logDir(sid, true)]) {
    if (!dir) continue;
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, name), JSON.stringify(data) + '\n');
      return;
    } catch (e) {
      why = e.code || e.message;
    }
  }
  if (why) process.stderr.write(P + ' conventions: marker not written (' + why + ')\n');
}

/** The login this process runs under (doctor evidence only): label work|personal|unknown, the org type, the file read. */
function login() {
  const home = abs(process.env.HOME);
  const cfg = abs(process.env.CLAUDE_CONFIG_DIR) || home + '/.claude';
  const file = cfg === home + '/.claude' ? home + '/.claude.json' : cfg + '/.claude.json';
  const a = (readJson(file) || {}).oauthAccount || {};
  const org = typeof a.organizationType === 'string' ? a.organizationType : null;
  const label = /^claude_(team|enterprise)$/.test(org) ? 'work' : /^claude_(max|pro)$/.test(org) ? 'personal' : 'unknown';
  return { label, org, file };
}

let T = null;
try {
  T = require('./conventions-text.json');
} catch {}

/** The session's sections in order: `{ sections: [name…], text }`; `<base root>` stays literal. */
function startText() {
  const parts = [['root', T.root.split('<root>').join(ROOT)], ['passwords', T.passwords]];
  return { sections: parts.map(([n]) => n), text: parts.map(([, t]) => t).join('\n\n') };
}

function main(argv) {
  const [mode] = argv;
  const input = readStdin();
  if (mode !== 'start') return;
  const r = startText();
  process.stdout.write(envelope('SessionStart', r.text));
  const { label, org, file } = login();
  writeMarker(input.session_id, 'conventions.qa.json', {
    via: 'hook', event: 'SessionStart', source: typeof input.source === 'string' ? input.source : null,
    sections: r.sections, chars: r.text.length, login: { label, org, file }, ts: new Date().toISOString(),
  });
}

module.exports = { startText, login, logDir };

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch {}
  process.exitCode = 0;
}
