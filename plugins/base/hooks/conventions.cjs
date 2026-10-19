#!/usr/bin/env node
/*
 * conventions.cjs — base's conventions as Claude Code command hooks (hooks/hooks.json), the one channel
 * that reaches the model on every login. Text: conventions-text.json. Modes (argv):
 *   start core   SessionStart: root line, comment discipline, task workspace, outside content, Shopify
 *   start rules  SessionStart: lean code (BASE_LEAN), writing style (BASE_STE), dogfood section
 *   subagent     SubagentStart: the share of the agent type on stdin
 *   stop         Stop: blocks once after a plugin-script failure the mod mirrored to dogfood-state.json
 * A start part writes the marker <log dir>/<session>/conventions.base[.rules].json, which the doctor and
 * the mod's cloud fallback read. Always exits 0; an internal error prints nothing.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const P = 'base';
const ROOT = (process.env.CLAUDE_PLUGIN_ROOT || '').replace(/\/+$/, '') || path.resolve(__dirname, '..');
const PLUGINS = ['slim', 'band', 'base', 'fe', 'be', 'qa', 'pm'];
/** Agents that write no code, by role: the code conventions skip them (an unknown type gets them). */
const NO_CODE_AGENT = /(-reader|-explorer|-reviewer|jira-writer|bug-hunter)$|^(Explore|Plan|claude-code-guide|statusline-setup)$/;

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

let loginMemo = null;
/**
 * The login this process runs under (doctor evidence only): label work|personal|unknown — `synced sandbox` for a
 * claude.ai-synced copy whose login file names no org type — the org type, the file read.
 */
function login() {
  if (loginMemo) return loginMemo;
  const home = abs(process.env.HOME);
  const cfg = abs(process.env.CLAUDE_CONFIG_DIR) || home + '/.claude';
  const file = cfg === home + '/.claude' ? home + '/.claude.json' : cfg + '/.claude.json';
  const a = (readJson(file) || {}).oauthAccount || {};
  const org = typeof a.organizationType === 'string' ? a.organizationType : null;
  const label = /^claude_(team|enterprise)$/.test(org) ? 'work' : /^claude_(max|pro)$/.test(org) ? 'personal' : !org && ROOT.includes('/plugins/synced/') ? 'synced sandbox' : 'unknown';
  loginMemo = { label, org, file, account: typeof a.accountUuid === 'string' ? a.accountUuid : '' };
  return loginMemo;
}

/** BASE_DOGFOOD 1/0 wins; else the account (CLAUDE_CODE_ACCOUNT_UUID, else the login file's) is one dogfood.json lists. */
function dogfoodOn() {
  const sw = process.env.BASE_DOGFOOD;
  if (sw === '1') return true;
  if (sw === '0') return false;
  const id = (process.env.CLAUDE_CODE_ACCOUNT_UUID || '').trim() || login().account;
  const accounts = (readJson(path.join(ROOT, 'dogfood.json')) || {}).accounts;
  return !!id && !!accounts && typeof accounts === 'object' && !Array.isArray(accounts) && Object.prototype.hasOwnProperty.call(accounts, id);
}

/** `slim 0.13.0, band (version unknown), base 0.10.4, …`: install records, then synced copies, base's own manifest; enabled names without a version. */
function versionsLine(cwd) {
  const home = abs(process.env.HOME);
  const cfg = abs(process.env.CLAUDE_CONFIG_DIR) || home + '/.claude';
  const recs = [];
  for (const [key, list] of Object.entries((readJson(cfg + '/plugins/installed_plugins.json') || {}).plugins || {})) {
    const at = key.lastIndexOf('@');
    if (at > 0 && Array.isArray(list)) for (const r of list) if (r && typeof r === 'object') recs.push([key.slice(0, at), key.slice(at + 1), r]);
  }
  const mk = (recs.find(([n, , r]) => n === 'base' && r.installPath === ROOT) || [])[1];
  const enabled = {};
  for (const f of [cfg + '/settings.json', cwd + '/.claude/settings.json', cwd + '/.claude/settings.local.json']) {
    const e = (readJson(f) || {}).enabledPlugins;
    if (e && typeof e === 'object') for (const [k, on] of Object.entries(e)) enabled[k.lastIndexOf('@') > 0 ? k.slice(0, k.lastIndexOf('@')) : k] = on === true;
  }
  let synced = [];
  try {
    synced = fs.readdirSync(cfg + '/plugins/synced').flatMap((acc) => fs.readdirSync(cfg + '/plugins/synced/' + acc).map((d) => cfg + '/plugins/synced/' + acc + '/' + d));
  } catch {}
  const syncedVersion = (p) => {
    for (const d of synced) {
      const name = path.basename(d);
      if (name !== p && !name.startsWith(p + '~')) continue;
      const v = (readJson(d + '/.claude-plugin/plugin.json') || {}).version;
      if (typeof v === 'string' && v) return v;
    }
    return null;
  };
  const own = (readJson(ROOT + '/.claude-plugin/plugin.json') || {}).version;
  const out = [];
  for (const p of PLUGINS) {
    const rec = recs.find(([n, m]) => n === p && m === mk) || recs.find(([n]) => n === p);
    const v = p === 'base' ? (typeof own === 'string' && own ? own : null)
      : rec && typeof rec[2].version === 'string' ? rec[2].version : rec ? null : syncedVersion(p);
    if (v !== null || p === 'base' || enabled[p]) out.push(v ? p + ' ' + v : p + ' (version unknown)');
  }
  return out.join(', ');
}

let T = null;
try {
  T = require('./conventions-text.json');
} catch {}
const section = (name) => T[name].split('<base root>').join(ROOT);
const surfaceless = () => (process.env.CLAUDE_CODE_ENTRYPOINT || '').startsWith('sdk') || process.env.CLAUDE_CODE_REMOTE === 'true';

function dogfoodSection(cwd) {
  return T.dogfood.split('{versions}').join(versionsLine(cwd)).split('{rule}').join(T[surfaceless() ? 'rule-surfaceless' : 'rule-drawn']);
}

/** The start part's sections in session order: `{ sections: [name…], text }`, text '' when none is on. */
function startPart(part, cwd) {
  const names = part === 'core'
    ? ['root', 'comment-discipline', 'task-workspace', 'untrusted-content', 'shopify']
    : [process.env.BASE_LEAN !== '0' && 'lean-code', process.env.BASE_STE !== '0' && 'writing-style', dogfoodOn() && 'dogfood'].filter(Boolean);
  const text = names.map((n) => (n === 'dogfood' ? dogfoodSection(cwd) : section(n))).join('\n\n');
  return { sections: names, text };
}

/** A subagent's share: root line and outside content; comment discipline and lean code for a code agent; dogfood when on. '' for a fork. */
function subagentText(agentType, cwd) {
  if (agentType === 'fork') return '';
  const parts = [section('root'), section('untrusted-content')];
  if (!NO_CODE_AGENT.test(agentType)) {
    parts.push(section('comment-discipline'));
    if (process.env.BASE_LEAN !== '0') parts.push(section('lean-code'));
  }
  if (dogfoodOn()) parts.push(dogfoodSection(cwd));
  return parts.join('\n\n');
}

/** The Stop block reason once per mirrored failure with no report after it; null otherwise. Writes dogfood-stop.json. */
function stopReason(input) {
  if (input.stop_hook_active === true) return null;
  const dir = logDir(input.session_id);
  const s = dir && readJson(dir + '/dogfood-state.json');
  if (!s || s.sid !== input.session_id || !s.failMs || s.reportMs >= s.failMs) return null;
  if ((readJson(dir + '/dogfood-stop.json') || {}).blockedMs === s.failMs || !dogfoodOn()) return null;
  fs.writeFileSync(dir + '/dogfood-stop.json', JSON.stringify({ blockedMs: s.failMs }) + '\n');
  return 'base dogfood: a plugin script failed (' + s.script + ') and no plugin_defect report followed — report it with plugin_defect (not among your tools: in your reply), then stop';
}

function main(argv) {
  const [mode, part] = argv;
  const input = readStdin();
  const cwd = typeof input.cwd === 'string' && input.cwd.startsWith('/') ? input.cwd : process.cwd();
  if (mode === 'start' && (part === 'core' || part === 'rules')) {
    const r = startPart(part, cwd);
    if (!r.text) return;
    process.stdout.write(envelope('SessionStart', r.text));
    const { label, org, file } = login();
    writeMarker(input.session_id, part === 'core' ? 'conventions.base.json' : 'conventions.base.rules.json', {
      via: 'hook', event: 'SessionStart', source: typeof input.source === 'string' ? input.source : null, part,
      sections: r.sections, chars: r.text.length, login: { label, org, file }, ts: new Date().toISOString(),
    });
  } else if (mode === 'subagent') {
    const text = subagentText(typeof input.agent_type === 'string' ? input.agent_type : '', cwd);
    if (text) process.stdout.write(envelope('SubagentStart', text));
  } else if (mode === 'stop') {
    const reason = stopReason(input);
    if (reason) process.stdout.write(JSON.stringify({ decision: 'block', reason }));
  }
}

module.exports = { startPart, subagentText, stopReason, versionsLine, login, dogfoodOn, logDir };

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch {}
  process.exitCode = 0;
}
