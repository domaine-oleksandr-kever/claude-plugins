#!/usr/bin/env node
/*
 * conventions.cjs — base's conventions as Claude Code command hooks (hooks/hooks.json), the one channel
 * that reaches the model on every login. Text: conventions-text.json. Modes (argv):
 *   start core   SessionStart: root line (+ a stale synced-copy line), comment discipline, task workspace, outside content, Shopify
 *   start rules  SessionStart: lean code (BASE_LEAN), writing style (BASE_STE), edit delegation (BASE_EDIT_MODEL), dogfood section
 *   subagent     SubagentStart: the share of the agent type on stdin; records the agent_type in
 *                <log dir>/<session>/agents/<agent_id>.json for base's MCP guard
 *   stop         Stop: blocks once per new plugin-script failure the mod listed in dogfood-state.json's `errors` and no report followed,
 *                and (BASE_AUTOSAVE) at most once per 3 turns a turn that did savable work and left the workspace in
 *                autosave-state.json stale; one block, both reasons
 *   precompact   PreCompact (auto): appends a `compact:` pointer line to a stale workspace's notes.md and records it in
 *                compact-marker.json, so the mod never counts it as a save
 * A start part writes the marker <log dir>/<session>/conventions.base[.rules].json, which the doctor and
 * the edit guard read. Always exits 0; an internal error prints nothing.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const P = 'base';
const ROOT = (process.env.CLAUDE_PLUGIN_ROOT || '').replace(/\/+$/, '') || path.resolve(__dirname, '..');
const PLUGINS = ['slim', 'band', 'base', 'fe', 'be', 'qa', 'pm'];
/** Agents that write no code, by role: the code conventions skip them (an unknown type gets them). */
const NO_CODE_AGENT = /(-reader|-explorer|-reviewer|-drafter|jira-writer|bug-hunter)$|^(Explore|Plan|claude-code-guide|statusline-setup)$/;
/** Agents that write prose for people: they also get writing style (BASE_STE). */
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

/** Writes `data` as JSON to `name` under the log dir, else the spare dir: printed context always leaves a marker. */
function writeMarker(sid, name, data) {
  let why = null;
  for (const dir of [logDir(sid), logDir(sid, true)]) {
    if (!dir) continue;
    try {
      fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
      fs.writeFileSync(path.join(dir, name), JSON.stringify(data) + '\n');
      return;
    } catch (e) {
      why = e.code || e.message;
    }
  }
  if (why) process.stderr.write(P + ' conventions: marker not written (' + why + ')\n');
}

/** Writes `type` to agents/<id>.json (log dir, else spare dir): one file per agent, so parallel starts lose none. */
function recordAgent(sid, id, type) {
  if (typeof id !== 'string' || !/^[\w.-]+$/.test(id) || /^\.+$/.test(id) || typeof type !== 'string' || !type) return;
  writeMarker(sid, 'agents/' + id + '.json', type);
}

let loginMemo = null;
/**
 * The login this process runs under (doctor evidence only): label work|personal|unknown — `synced sandbox` for a
 * claude.ai-synced copy whose login file names no org type — the org type, the file read.
 */
function login() {
  if (loginMemo) return loginMemo;
  const file = ED_() ? ED_().loginFile(process.env.HOME, process.env.CLAUDE_CONFIG_DIR) : null;
  const a = ((file && readJson(file)) || {}).oauthAccount || {};
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

// Loaded on first use: title.cjs requires this file on every prompt and needs neither.
let texts;
let edMod;
let doctorMod;
const tryRequire = (p) => {
  try {
    return require(p);
  } catch {
    return null;
  }
};
const T_ = () => (texts === undefined ? (texts = tryRequire('./conventions-text.json')) : texts);
const ED_ = () => (edMod === undefined ? (edMod = tryRequire('../scripts/edit-delegation.cjs')) : edMod);
const DOC_ = () => (doctorMod === undefined ? (doctorMod = tryRequire('../scripts/doctor.cjs')) : doctorMod);
const section = (name) => T_()[name].split('<base root>').join(ROOT);

/** The line after the root line when base runs from a claude.ai-synced copy older than the install record in the same config dir; '' otherwise. */
function syncedCopyLine(cwd) {
  const at = ROOT.indexOf('/plugins/synced/');
  const doc = at > 0 ? DOC_() : null;
  if (!doc) return '';
  const own = (readJson(ROOT + '/.claude-plugin/plugin.json') || {}).version;
  const inst = doc.recordedPlugin(P, ROOT.slice(0, at), cwd, {});
  if (typeof own !== 'string' || !own || !inst || !(doc.versionKey(own) < doc.versionKey(inst.version))) return '';
  return 'base: this session loaded the claude.ai-synced copy ' + own + ' (' + ROOT + '); the marketplace install is ' + inst.version +
    ' — re-sync the plugin in claude.ai or set "base@synced": false in enabledPlugins';
}
const surfaceless = () => (process.env.CLAUDE_CODE_ENTRYPOINT || '').startsWith('sdk') || process.env.CLAUDE_CODE_REMOTE === 'true';

function dogfoodSection(cwd) {
  return T_().dogfood.split('{versions}').join(versionsLine(cwd)).split('{rule}').join(T_()[surfaceless() ? 'rule-surfaceless' : 'rule-drawn']);
}

/** The edit-delegation decision (scripts/edit-delegation.cjs decides; the doctor asks the same); null without the module. */
const editDecision = () => (ED_() ? ED_().editDelegation({ env: process.env, home: process.env.HOME, configDir: process.env.CLAUDE_CONFIG_DIR, root: ROOT }) : null);
const editSection = (d) => T_()['edit-delegation'].split('{model}').join(d.model).split('{why}').join(ED_().whyText(d));

/** The start part's sections in session order: `{ sections: [name…], text, edit }`, text '' when none is on; `edit` the rules part's delegation decision. */
function startPart(part, cwd) {
  const edit = part === 'core' ? null : editDecision();
  const names = part === 'core'
    ? ['root', 'comment-discipline', 'task-workspace', 'untrusted-content', 'shopify']
    : [process.env.BASE_LEAN !== '0' && 'lean-code', process.env.BASE_STE !== '0' && 'writing-style', edit && edit.model && 'edit-delegation', dogfoodOn() && 'dogfood'].filter(Boolean);
  const text = names.map((n) => (n === 'dogfood' ? dogfoodSection(cwd) : n === 'edit-delegation' ? editSection(edit)
    : n === 'root' ? [section(n), syncedCopyLine(cwd)].filter(Boolean).join('\n') : section(n))).join('\n\n');
  return { sections: names, text, edit };
}

/**
 * A subagent's share: root line and outside content; comment discipline and lean code for a code agent; writing style
 * for a drafter (BASE_STE); dogfood when on. Never edit delegation. '' for a fork.
 */
function subagentText(agentType, cwd) {
  if (agentType === 'fork') return '';
  const parts = [section('root'), section('untrusted-content')];
  if (!NO_CODE_AGENT.test(agentType)) {
    parts.push(section('comment-discipline'));
    if (process.env.BASE_LEAN !== '0') parts.push(section('lean-code'));
  }
  if (DRAFTER_AGENT.test(agentType) && process.env.BASE_STE !== '0') parts.push(section('writing-style'));
  if (dogfoodOn()) parts.push(dogfoodSection(cwd));
  return parts.join('\n\n');
}

/**
 * The Stop block reason while the mirrored `errors` hold a failure after the last report, once per newest failure: the count and each
 * script with its first error line. null otherwise. Writes dogfood-stop.json.
 */
function stopReason(input) {
  if (input.stop_hook_active === true) return null;
  const dir = logDir(input.session_id);
  const s = dir && readJson(dir + '/dogfood-state.json');
  if (!s || s.sid !== input.session_id || !Array.isArray(s.errors)) return null;
  const open = s.errors.filter((e) => e && typeof e.script === 'string' && typeof e.ms === 'number' && e.ms > (Number(s.reportMs) || 0));
  if (!open.length) return null;
  const newest = Math.max(...open.map((e) => e.ms));
  if ((readJson(dir + '/dogfood-stop.json') || {}).blockedMs === newest || !dogfoodOn()) return null;
  fs.writeFileSync(dir + '/dogfood-stop.json', JSON.stringify({ blockedMs: newest }) + '\n');
  const first = new Map();
  for (const e of open) if (!first.has(e.script)) first.set(e.script, typeof e.line === 'string' ? e.line : '');
  const names = [...first].map(([script, line]) => (line ? script + ' (' + line + ')' : script)).join(', ');
  return 'base: ' + open.length + ' plugin script error(s) this session are not reported — report each with plugin_defect or say why not: ' + names;
}

const AUTOSAVE_EVERY = 3;
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * The workspace autosave-state.json names for this session, with its newest root-file write re-listed now (notes.md still at
 * compact-marker.json's write keeps the time before it) and `stale` cleared by a write since the mirror. null when off or absent.
 */
function autosaveWorkspace(dir, sid) {
  if (process.env.BASE_AUTOSAVE === '0' || !dir) return null;
  const s = readJson(dir + '/autosave-state.json');
  if (!s || s.sid !== sid || typeof s.workId !== 'string' || !/^[\w.-]+$/.test(s.workId) || /^\.+$/.test(s.workId) || typeof s.wsDir !== 'string' || !s.wsDir.startsWith('/') || !s.wsDir.endsWith('/.claude/tasks/' + s.workId)) return null;
  const m = readJson(dir + '/compact-marker.json');
  let newest = 0;
  try {
    for (const name of fs.readdirSync(s.wsDir)) {
      let st;
      try {
        st = fs.statSync(path.join(s.wsDir, name));
      } catch {
        continue;
      }
      if (st.isFile()) newest = Math.max(newest, name === 'notes.md' && m && m.workId === s.workId && st.mtimeMs === m.notesMs ? num(m.priorMs) : st.mtimeMs);
    }
  } catch {}
  const mtimeMs = Math.max(num(s.mtimeMs), newest);
  return { ...s, mtimeMs, stale: s.stale === true && mtimeMs <= num(s.mtimeMs) };
}

/** The autosave Stop reason: a stale workspace not written since the turn began, savable work in the turn, once per 3 turns. Writes autosave-stop.json. */
function autosaveReason(input) {
  if (input.stop_hook_active === true) return null;
  const dir = logDir(input.session_id);
  const ws = autosaveWorkspace(dir, input.session_id);
  if (!ws || !ws.stale || ws.mtimeMs >= num(ws.startMs) || num(ws.lastSavableMs) < num(ws.startMs)) return null;
  const turn = num(ws.turn);
  const blocked = num((readJson(dir + '/autosave-stop.json') || {}).blockedTurn);
  if (blocked && turn - blocked >= 0 && turn - blocked < AUTOSAVE_EVERY) return null;
  fs.writeFileSync(dir + '/autosave-stop.json', JSON.stringify({ blockedTurn: turn }) + '\n');
  return 'save interim findings to the workspace (.claude/tasks/' + ws.workId + '/notes.md), then stop';
}

/** Before an auto-compact: one `compact:` line on a stale workspace's notes.md (left alone when it exists but cannot be read), then compact-marker.json. */
function compactNote(input, now) {
  if (input.trigger !== 'auto') return;
  const dir = logDir(input.session_id);
  const ws = autosaveWorkspace(dir, input.session_id);
  if (!ws || !ws.stale) return;
  const notes = ws.wsDir + '/notes.md';
  let text = '';
  try {
    text = fs.readFileSync(notes, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') return;
  }
  const age = ws.mtimeMs ? ' ' + Math.floor((now - ws.mtimeMs) / 60000) + ' min' : ', nothing saved yet';
  const line = '- ' + new Date(now).toISOString().slice(0, 10) + ' compact: workspace stale' + age + '; since then ' + num(ws.agentsSince) + ' reader agents, ' + num(ws.editsSince) + ' edits\n';
  fs.writeFileSync(notes, text && !text.endsWith('\n') ? text + '\n' + line : text + line);
  fs.writeFileSync(dir + '/compact-marker.json', JSON.stringify({ workId: ws.workId, notesMs: fs.statSync(notes).mtimeMs, priorMs: ws.mtimeMs }) + '\n');
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
      sections: r.sections, chars: r.text.length, login: { label, org, file },
      ...(r.edit && r.edit.model ? { edit: { model: r.edit.model, kind: r.edit.kind, source: r.edit.source } } : {}),
      ts: new Date().toISOString(),
    });
  } else if (mode === 'subagent') {
    recordAgent(input.session_id, input.agent_id, input.agent_type);
    const text = subagentText(typeof input.agent_type === 'string' ? input.agent_type : '', cwd);
    if (text) process.stdout.write(envelope('SubagentStart', text));
  } else if (mode === 'stop') {
    let saveReason = null;
    try {
      saveReason = autosaveReason(input);
    } catch {}
    const reasons = [stopReason(input), saveReason].filter(Boolean);
    if (reasons.length) process.stdout.write(JSON.stringify({ decision: 'block', reason: reasons.join('\n') }));
  } else if (mode === 'precompact') {
    compactNote(input, Date.now());
  }
}

module.exports = { startPart, subagentText, stopReason, versionsLine, login, dogfoodOn, logDir, writeMarker, readStdin, editDecision };

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch {}
  process.exitCode = 0;
}
