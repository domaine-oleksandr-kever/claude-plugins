// Session title, both hook paths: SessionStart names the session from the branch, and
// UserPromptSubmit names it from the first prompt that carries a ticket. One module so the two
// paths cannot drift on what a key is, where the summary comes from and how the title reads —
// `<KEY> — <summary>`, or `<KEY>` alone when no ticket.md answers.
//
// Claude Code is the only host that reads `sessionTitle`; the callers gate on FND_HOST and on
// FND_SESSION_TITLE. Every failure here returns null: a session that keeps the host's own name
// has lost nothing.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const KEY_SRC = '\\b[A-Z][A-Z0-9]{1,9}-[0-9]{1,7}\\b';
const KEY = new RegExp(KEY_SRC);
const WORKSPACE_KEY = /^[A-Z][A-Z0-9]{1,9}-[0-9]{1,7}$/;
const TICKET_HEAD_BYTES = 4096;
// Bytes, not characters: the title rides in the SessionStart envelope, which is budgeted in bytes
// (tests/hooks-sim.sh S25) and where a Cyrillic summary costs two of them per character.
const TITLE_MAX_BYTES = 100;

function firstKey(text) {
  const m = KEY.exec(String(text || ''));
  return m ? m[0] : null;
}

// Which Jira projects this checkout has worked. A BARE key is not evidence of a ticket — UTF-8,
// SHA-256, ISO-8601 and AES-256 all match the shape — so the prompt half asks this first.
function projectPrefixes(cwd) {
  const out = new Set();
  try {
    for (const e of fs.readdirSync(path.join(cwd, '.claude', 'tasks'), { withFileTypes: true })) {
      if (e.isDirectory() && WORKSPACE_KEY.test(e.name)) out.add(e.name.slice(0, e.name.indexOf('-')));
    }
  } catch (_) {}
  return out;
}

// A prompt key counts only once something corroborates it: a Jira `/browse/` URL, or a workspace
// under `.claude/tasks/` for the same project. Every match is walked, so a prompt that opens with
// `UTF-8` and goes on to name the real ticket is still titled by the ticket.
function promptKey(text, cwd) {
  const s = String(text || '');
  if (!KEY.test(s)) return null;
  const known = projectPrefixes(cwd);
  const re = new RegExp(KEY_SRC, 'g');
  let m;
  while ((m = re.exec(s)) !== null) {
    const key = m[0];
    if (known.has(key.slice(0, key.indexOf('-')))) return key;
    if (/browse\/$/i.test(s.slice(Math.max(0, m.index - 7), m.index))) return key;
  }
  return null;
}

// The summary is jira-reader's own `# <KEY> — <summary>` heading line; its separator has been
// spelled `—`, `:` and `-` across versions, so the strip is anchored to those separators — an
// "everything up to the first ASCII letter" strip eats an accented or non-Latin first word.
function ticketSummary(cwd, key) {
  try {
    const file = path.join(cwd, '.claude', 'tasks', key, 'ticket.md');
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(TICKET_HEAD_BYTES);
    let n = 0;
    try { n = fs.readSync(fd, buf, 0, TICKET_HEAD_BYTES, 0); } finally { fs.closeSync(fd); }
    for (const line of buf.slice(0, n).toString('utf8').split('\n')) {
      if (line.startsWith(`# ${key}`)) {
        return line.slice(key.length + 2).replace(/^[\s–—:|-]+/, '').trim() || null;
      }
    }
  } catch (_) {}
  return null;
}

// Cut on a character boundary: a Buffer slice through a multibyte character decodes to U+FFFD.
function clampBytes(s) {
  if (Buffer.byteLength(s) <= TITLE_MAX_BYTES) return s;
  return Buffer.from(s).slice(0, TITLE_MAX_BYTES).toString('utf8').replace(/�+$/, '').trim();
}

function titleFor(cwd, key) {
  const s = ticketSummary(cwd, key);
  return clampBytes(s ? `${key} — ${s}` : key);
}

function markerPath(input) {
  const sid = String(
    (input && input.session_id) ||
      (input && input.transcript_path ? path.basename(String(input.transcript_path), '.jsonl') : ''),
  ).replace(/[^A-Za-z0-9_.-]/g, '');
  if (!sid) return null; // without a session identity the one-shot cannot hold
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  return path.join(os.tmpdir(), `fnd-ses-title-${uid}-${sid}`);
}

function spend(input, key) {
  try {
    const marker = markerPath(input);
    if (marker) fs.writeFileSync(marker, key, { mode: 0o600 });
  } catch (_) {}
}

// SessionStart: the branch names the work. A session the developer already named (`--name`,
// `/rename`) keeps that name — the input carries it. Either outcome SETTLES the name, so both
// spend the session's one shot: the prompt half runs later and would otherwise overwrite it.
function startTitle(branch, cwd, input) {
  try {
    if (input && String(input.session_title || '').trim()) {
      spend(input, 'user');
      return null;
    }
    const key = firstKey(branch);
    if (!key) return null;
    spend(input, key);
    return titleFor(cwd || process.cwd(), key);
  } catch (_) {
    return null;
  }
}

// UserPromptSubmit: the FIRST prompt of this session that carries a key titles it, and the marker
// is written only once a title actually goes out — so a session whose opening prompts held no
// ticket is still named by the one that finally does, and a re-run of an already-titling prompt
// (or a prompt the guard erased, which never reaches this half) does not re-title.
function promptTitle(input) {
  try {
    const marker = markerPath(input);
    if (!marker) return null;
    try { if (fs.existsSync(marker)) return null; } catch (_) { return null; }
    const cwd = input.cwd || process.cwd();
    const key = promptKey(input.prompt, cwd);
    if (!key) return null;
    const title = titleFor(cwd, key);
    spend(input, key);
    return title;
  } catch (_) {
    return null;
  }
}

module.exports = { startTitle, promptTitle, firstKey, promptKey };
