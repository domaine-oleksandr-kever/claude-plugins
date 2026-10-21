#!/usr/bin/env node
/*
 * conventions.cjs — fe's conventions as Claude Code command hooks (hooks/hooks.json), the one channel that
 * reaches the model on every login. Text: conventions-text.json. Modes (argv):
 *   start     SessionStart: root line, profile line, Foundation rules, store access, worktree line, preview default
 *             line (FE_PREVIEW_DEFAULT), progress series
 *   subagent  SubagentStart: the share of the agent type on stdin
 * start decides the project profile (FE_PROFILE, else scripts/project-profile.sh with a 5 s timeout) and writes
 * the marker <log dir>/<session>/conventions.fe.json, which subagent, base's doctor and the mod's cloud fallback
 * read. Always exits 0; an internal error prints nothing.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const P = 'fe';
const ROOT = (process.env.CLAUDE_PLUGIN_ROOT || '').replace(/\/+$/, '') || path.resolve(__dirname, '..');
const PROFILE_TIMEOUT_MS = 5000;
const WORDS = ['foundation', 'theme', 'none'];
/** base's readers and writer, and Claude Code's own helpers: no fe context at all. */
const NO_FE_AGENT = /(^|:)(jira-reader|jira-writer|figma-reader|doc-reader)$|^(claude-code-guide|statusline-setup)$/;
/** Agents that read the theme without writing it: the root, the profile and the Foundation rules, no store access. */
const READ_ONLY_AGENT = /(^|:)(theme-explorer|change-reviewer|bug-hunter)$|^(Explore|Plan)$/;
/** Agents that write prose, not theme code: the root, the profile and store access, no Foundation rules. */
const DRAFTER_AGENT = /-drafter$/;

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

/**
 * 'off' when FE_PREVIEW_DEFAULT is 0, else 'on'. A set env value wins, even an empty one; else the first
 * `FE_PREVIEW_DEFAULT=` line of `${XDG_CONFIG_HOME:-$HOME/.config}/domaine/env`, trimmed, never sourced — the
 * dialect of scripts/_shopify-common.sh domaine_env. The project `.claude/domaine.env` is not read: a client
 * repo can commit it.
 */
function previewDefault(env = process.env) {
  let v = env.FE_PREVIEW_DEFAULT;
  if (v === undefined) {
    const home = abs(env.HOME);
    const xdg = abs(env.XDG_CONFIG_HOME) || (home && home + '/.config');
    try {
      const line = fs.readFileSync(xdg + '/domaine/env', 'utf8').split('\n').find((l) => /^\s*FE_PREVIEW_DEFAULT\s*=/.test(l));
      if (line !== undefined) v = line.replace(/^[^=]*=/, '');
    } catch {}
  }
  return String(v === undefined ? '' : v).trim() === '0' ? 'off' : 'on';
}

const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim().slice(0, 120);

/** `{ word, via, why, toml, store }` for the checkout at `cwd`: FE_PROFILE when it is one of the three words, else the probe, else none. */
function decideProfile(cwd) {
  const has = (f) => fs.existsSync(path.join(cwd, f));
  const toml = has('shopify.theme.toml');
  const env = has('.env');
  const info = (word, via, why) => ({ word, via, why, toml, store: toml || (env && word !== 'none') });
  const forced = (process.env.FE_PROFILE || '').trim();
  if (WORDS.includes(forced)) return info(forced, 'FE_PROFILE', null);
  const r = spawnSync('bash', [ROOT + '/scripts/project-profile.sh', cwd], { encoding: 'utf8', timeout: PROFILE_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.error) return info('none', 'fallback', 'project-profile.sh did not run: ' + oneLine(r.error.message));
  const word = (r.stdout || '').trim();
  if (r.status === 0 && WORDS.includes(word)) return info(word, 'project-profile.sh', null);
  return info('none', 'fallback', 'project-profile.sh exited ' + r.status + ': ' + (oneLine((r.stderr || '').split('\n')[0] || word) || 'no answer'));
}

let T = null;
try {
  T = require('./conventions-text.json');
} catch {}
const rootLine = () => T.root.split('<root>').join(ROOT);
const profileLine = (word) => T.profile.split('<profile>').join(word);
const storeAccess = () => T['store-access'].split('<fe root>').join(ROOT);
const previewSection = () => {
  const name = previewDefault() === 'off' ? 'preview-default-off' : 'preview-default-on';
  return [name, T[name].split('<fe root>').join(ROOT)];
};

/** The session's sections in order: `{ sections: [name…], text }`. */
function startText(p) {
  const parts = [['root', rootLine()], ['profile', profileLine(p.word)]];
  if (p.word === 'foundation') parts.push(['comment-discipline-foundation', T['comment-discipline-foundation']]);
  if (p.store) parts.push(['store-access', storeAccess()]);
  if (p.toml) parts.push(['worktree', T.worktree]);
  if (p.toml) parts.push(previewSection());
  if (p.toml || p.word !== 'none') parts.push(['progress-series', T['progress-series']]);
  return { sections: parts.map(([n]) => n), text: parts.map(([, t]) => t).join('\n\n') };
}

/** A subagent's share: '' for a fork and base's readers; root, profile and Foundation rules (not for a drafter); store access unless read-only. */
function subagentText(agentType, p) {
  if (agentType === 'fork' || NO_FE_AGENT.test(agentType)) return '';
  const parts = [rootLine(), profileLine(p.word)];
  if (p.word === 'foundation' && !DRAFTER_AGENT.test(agentType)) parts.push(T['comment-discipline-foundation']);
  if (p.store && !READ_ONLY_AGENT.test(agentType)) parts.push(storeAccess());
  return parts.join('\n\n');
}

/** The profile the session's start hook decided (its marker), else decided now. */
function sessionProfile(sid, cwd) {
  const marker = [logDir(sid), logDir(sid, true)].map((d) => d && readJson(d + '/conventions.fe.json')).find(Boolean);
  const p = (marker || {}).profile;
  return p && WORDS.includes(p.word) ? p : decideProfile(cwd);
}

function main(argv) {
  const [mode] = argv;
  const input = readStdin();
  const cwd = typeof input.cwd === 'string' && input.cwd.startsWith('/') ? input.cwd : process.cwd();
  if (mode === 'start') {
    const profile = decideProfile(cwd);
    const r = startText(profile);
    process.stdout.write(envelope('SessionStart', r.text));
    const { label, org, file } = login();
    writeMarker(input.session_id, 'conventions.fe.json', {
      via: 'hook', event: 'SessionStart', source: typeof input.source === 'string' ? input.source : null,
      sections: r.sections, chars: r.text.length, login: { label, org, file }, profile, ts: new Date().toISOString(),
    });
  } else if (mode === 'subagent') {
    const agentType = typeof input.agent_type === 'string' ? input.agent_type : '';
    if (agentType === 'fork' || NO_FE_AGENT.test(agentType)) return;
    const text = subagentText(agentType, sessionProfile(input.session_id, cwd));
    if (text) process.stdout.write(envelope('SubagentStart', text));
  }
}

module.exports = { decideProfile, startText, subagentText, sessionProfile, login, logDir, previewDefault };

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch {}
  process.exitCode = 0;
}
