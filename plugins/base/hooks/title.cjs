#!/usr/bin/env node
/*
 * title.cjs — the session title `<KEY> — <summary>` as Claude Code command hooks (hooks/hooks.json), on every
 * login. Modes (argv):
 *   start   SessionStart: a ticket key in the branch that the checkout's .claude/tasks dirs corroborate
 *   prompt  UserPromptSubmit: the most recent corroborated ticket a person's prompt names
 * One shot per session: <log dir>/<session>/title.json {sid, by, title?, ts} (log dir, else spare dir) ends it,
 * `by: 'user'` when the person had set a title. base's mod adopts it into base.events and base.jsonl.
 * BASE_SESSION_TITLE=0 turns it off. Always exits 0; an internal error prints nothing.
 */
'use strict';

const fs = require('fs');
const { execFileSync } = require('child_process');
const { logDir, readStdin, writeMarker } = require('./conventions.cjs');

const KEY = /\b[A-Z][A-Z0-9]{1,9}-[0-9]{1,7}\b/;
const KEY_WHOLE = new RegExp('^' + KEY.source.replace(/\\b/g, '') + '$');
/** Bytes, not characters: a Cyrillic summary costs two per character in the hook envelope. */
const TITLE_MAX_BYTES = 100;
/** UserPromptSubmit sources a person wrote; an absent source is a person's prompt on a host that predates it. */
const PERSON = new Set(['user', 'sdk']);

/** First ticket key in a branch name, else null. */
function keyFromBranch(branch) {
  const m = KEY.exec(branch || '');
  return m ? m[0] : null;
}

/** `ABC-1591` → `ABC`; a slug → null. */
function projectOf(id) {
  return KEY_WHOLE.test(id) ? id.slice(0, id.indexOf('-')) : null;
}

/** The projects of a checkout's `.claude/tasks/<KEY>` dir names: what corroborates a bare key. */
function projectsOf(dirs) {
  const out = new Set();
  for (const d of dirs) {
    const project = projectOf(d);
    if (project) out.add(project);
  }
  return out;
}

/** The tickets a text names, the most recent first: a Jira `/browse/<KEY>` URL or a `known` project corroborates a key. */
function ticketKeys(text, known) {
  const s = text || '';
  const out = [];
  const re = new RegExp(KEY.source, 'g');
  let m;
  while ((m = re.exec(s)) !== null) {
    const key = m[0];
    const browse = /browse\/$/i.test(s.slice(Math.max(0, m.index - 7), m.index));
    if (browse || known.has(key.slice(0, key.indexOf('-')))) out.push(key);
  }
  return out.reverse();
}

/**
 * The summary from the ticket reader's `# <KEY> — <summary>` heading (its separator has been `—`, `:` and
 * `-`), then `<KEY> — <summary>` or the key alone, cut on a character boundary at 100 UTF-8 bytes.
 */
function titleText(key, ticketMd) {
  let summary = null;
  for (const line of ticketMd.split('\n')) {
    if (line.startsWith('# ' + key) && !/[0-9]/.test(line.charAt(key.length + 2))) {
      summary = line.slice(key.length + 2).replace(/^[\s–—:|-]+/, '').trim() || null;
      break;
    }
  }
  const full = summary ? key + ' — ' + summary : key;
  let bytes = 0;
  let out = '';
  for (const ch of full) {
    const cp = ch.codePointAt(0);
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    if (bytes > TITLE_MAX_BYTES) return out.trim();
    out += ch;
  }
  return out;
}

function git(cwd, args) {
  try {
    return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim() || null;
  } catch {
    return null;
  }
}

function taskDirs(root) {
  try {
    return fs.readdirSync(root + '/.claude/tasks', { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
}

/** The title for `mode`, or null: no key, an uncorroborated one, or a prompt no person wrote. */
function resolve(mode, input, cwd) {
  const prompt = typeof input.prompt === 'string' ? input.prompt : '';
  if (mode === 'prompt' && ((input.source !== undefined && !PERSON.has(input.source)) || !KEY.test(prompt))) return null;
  const root = git(cwd, ['rev-parse', '--show-toplevel']) || cwd;
  const dirs = taskDirs(root);
  let key;
  if (mode === 'start') {
    key = keyFromBranch(git(root, ['rev-parse', '--abbrev-ref', 'HEAD']));
    // key shape alone is no evidence: `fix/UTF-8-encoding` names no ticket
    if (!key || !(dirs.includes(key) || projectsOf(dirs).has(projectOf(key)))) return null;
  } else {
    key = ticketKeys(prompt, projectsOf(dirs))[0];
    if (!key) return null;
  }
  let md = '';
  try {
    md = fs.readFileSync(root + '/.claude/tasks/' + key + '/ticket.md', 'utf8');
  } catch {}
  return titleText(key, md);
}

function main(argv) {
  const mode = argv[0];
  if ((mode !== 'start' && mode !== 'prompt') || process.env.BASE_SESSION_TITLE === '0') return;
  const input = readStdin();
  const sid = input.session_id;
  const dirs = [logDir(sid), logDir(sid, true)].filter(Boolean);
  if (!dirs.length || dirs.some((d) => fs.existsSync(d + '/title.json'))) return;
  if (typeof input.session_title === 'string' && input.session_title.trim()) {
    writeMarker(sid, 'title.json', { sid, by: 'user', ts: Date.now() });
    return;
  }
  const cwd = typeof input.cwd === 'string' && input.cwd.startsWith('/') ? input.cwd : process.cwd();
  const title = resolve(mode, input, cwd);
  if (!title) return;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: mode === 'start' ? 'SessionStart' : 'UserPromptSubmit', sessionTitle: title } }));
  writeMarker(sid, 'title.json', { sid, by: 'base', title, ts: Date.now() });
}

module.exports = { keyFromBranch, projectOf, projectsOf, ticketKeys, titleText };

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch {}
  process.exitCode = 0;
}
