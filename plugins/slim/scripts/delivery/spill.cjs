// Files on disk: the spills slim writes (originals and the parts an engine's text cites), their TTL
// sweep, and the rules for which existing files a handle or a host notice may name.
// Spill names keep the `fnd-` prefixes for now; CONTRACT.md §7 holds the name set and the handle grammar.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const env = require('./env.cjs');

const NAMES = { original: 'fnd-mcp-slim-', rows: 'fnd-crush-', ids: 'fnd-jsx-ids-' };
const SPILL_NAME = /^fnd-mcp-slim-[0-9a-f]{16}(?:-[0-9a-f]{8})?\.(?:json|txt)$/;
const HOST_NAME = /^[\w.-]+\.(?:txt|json)$/;
const HOST_MAX = 33554432;
// Only the names slim writes; any other file in the spill root is left alone.
const SWEEP_PREFIXES = ['fnd-mcp-slim-', 'fnd-crush-', 'fnd-jsx-ids-'];
const SWEEP_MARKER = '.slim-sweep';
const SWEEP_KEEP = new Set(['fnd-mcp-slim-debug.log', 'fnd-mcp-slim-debug.log.1']);
const SWEEP_THROTTLE_MS = 10 * 60 * 1000;

const sha = (s, n) => crypto.createHash('sha256').update(s, 'utf8').digest('hex').slice(0, n);
const real = (p) => { try { return fs.realpathSync(p); } catch (_) { return null; } };
const owned = (st) => typeof process.getuid !== 'function' || st.uid === process.getuid();

// Atomic, 0600, never through a planted link: tmp `wx` + rename.
function writeAtomic(p, text) {
  let tmp = `${p}.tmp-${process.pid}`;
  try {
    try {
      fs.writeFileSync(tmp, text, { flag: 'wx', mode: 0o600 });
    } catch (e) {
      if (!e || e.code !== 'EEXIST') throw e;
      tmp = `${p}.tmp-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
      fs.writeFileSync(tmp, text, { flag: 'wx', mode: 0o600 });
    }
    fs.renameSync(tmp, p);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw e;
  }
}

// The same bytes already at `p`, owned and readable: re-dated so the sweep keeps it behind a new handle.
function reuse(p, bytes) {
  let st;
  try { st = fs.lstatSync(p); } catch (_) { return null; }
  if (!st.isFile() || st.size !== bytes || !owned(st)) return false;
  try { fs.accessSync(p, fs.constants.R_OK); } catch (_) { return false; }
  try { const now = new Date(); fs.utimesSync(p, now, now); } catch (_) {}
  return true;
}

// A part at exactly the name the engine's text cites → {path, created}, or null when that name holds
// foreign bytes or cannot be written (the text would then cite the wrong file). `dir` defaults to the
// spill root.
function writePart(name, payload, dir) {
  try {
    const root = dir || env.spillRoot();
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const p = path.join(root, name);
    const r = reuse(p, Buffer.byteLength(payload, 'utf8'));
    if (r === true) return { path: p, created: false };
    if (r === false) return null;
    writeAtomic(p, payload);
    return { path: p, created: true };
  } catch (_) {
    return null;
  }
}

// A whole original under a content-addressed name; a name holding foreign bytes moves to a second
// content-addressed name, then to a random one, so nothing foreign is ever handed back. `at` names
// another directory and prefix (the prompt channel's durable dir); the default is the spill root.
function writeOriginal(text, ext = '.json', at) {
  try {
    const root = (at && at.dir) || env.spillRoot();
    const prefix = (at && at.prefix) || NAMES.original;
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const bytes = Buffer.byteLength(text, 'utf8');
    const hash = sha(text, 16);
    for (const name of [`${prefix}${hash}${ext}`, `${prefix}${hash}-${sha(`${hash}:${bytes}`, 8)}${ext}`]) {
      const p = path.join(root, name);
      const r = reuse(p, bytes);
      if (r === true) return { path: p, created: false };
      if (r === null) { writeAtomic(p, text); return { path: p, created: true }; }
    }
    const p = path.join(root, `${prefix}${hash}-${crypto.randomUUID().slice(0, 8)}${ext}`);
    writeAtomic(p, text);
    return { path: p, created: true };
  } catch (_) {
    return null;
  }
}

function spillTtlHours(raw) {
  if (raw === undefined || raw === null || raw === '') return 24;
  const n = parseFloat(raw);
  return !Number.isFinite(n) || n < 0 ? 24 : n;
}

// Age-based sweep of the spill root, at most once per throttle window. Every error is swallowed.
function sweep() {
  try {
    const ttl = spillTtlHours(env.ttlRaw());
    if (ttl === 0) return;
    const root = env.spillRoot();
    const marker = path.join(root, SWEEP_MARKER);
    const now = Date.now();
    try { if (now - fs.statSync(marker).mtimeMs < SWEEP_THROTTLE_MS) return; } catch (_) {}
    try { fs.writeFileSync(marker, ''); } catch (_) {}
    const cutoff = now - ttl * 3600 * 1000;
    let names = [];
    try { names = fs.readdirSync(root); } catch (_) {}
    for (const name of names) {
      if (SWEEP_KEEP.has(name) || !SWEEP_PREFIXES.some((p) => name.startsWith(p))) continue;
      try {
        const p = path.join(root, name);
        const st = fs.lstatSync(p);
        if (st.isFile() && st.mtimeMs < cutoff) fs.unlinkSync(p);
      } catch (_) {}
    }
  } catch (_) {}
}

const projectsDir = () => {
  const cfg = String(process.env.CLAUDE_CONFIG_DIR || '').trim();
  return real(path.join(path.isAbsolute(cfg) ? cfg : path.join(os.homedir(), '.claude'), 'projects'));
};

// The segments of a realpath under <config>/projects, or null.
function projectSegs(file) {
  const projects = projectsDir();
  if (!projects) return null;
  const rel = path.relative(projects, file);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep);
}

// A host tool-results file of THIS session → {file, size}, or {why}. Payload text can forge a notice,
// so only this exact place, a regular file this user owns, qualifies.
function hostFile(p, sessionId) {
  if (typeof sessionId !== 'string' || !/^[\w-]+$/.test(sessionId)) return { why: 'expand-refused' };
  if (typeof p !== 'string' || !path.isAbsolute(p)) return { why: 'expand-refused' };
  const file = real(p);
  if (!file) return { why: 'expand-missing' };
  const segs = projectSegs(file);
  if (!segs || segs.length !== 4 || segs[1] !== sessionId || segs[2] !== 'tool-results' || !HOST_NAME.test(segs[3])) return { why: 'expand-refused' };
  let st;
  try { st = fs.statSync(file); } catch (_) { return { why: 'expand-missing' }; }
  if (!st.isFile() || !owned(st)) return { why: 'expand-refused' };
  if (st.size > HOST_MAX) return { why: 'expand-oversize' };
  return { file, size: st.size };
}

// → {text, file} or {why}.
function readHost(p, sessionId) {
  const h = hostFile(p, sessionId);
  if (!h.file) return h;
  try { return { text: fs.readFileSync(h.file, 'utf8'), file: h.file }; } catch (_) { return { why: 'expand-missing' }; }
}

// A whole local file the model asked to Read → {text, file} or {why}.
function readLocal(p) {
  const file = typeof p === 'string' ? real(p) : null;
  if (!file) return { why: 'expand-missing' };
  let st;
  try { st = fs.statSync(file); } catch (_) { return { why: 'expand-missing' }; }
  if (!st.isFile()) return { why: 'expand-refused' };
  if (st.size > HOST_MAX) return { why: 'expand-oversize' };
  try { return { text: fs.readFileSync(file, 'utf8'), file }; } catch (_) { return { why: 'expand-missing' }; }
}

const spillDirs = () => [env.spillRoot(), os.tmpdir()].filter(Boolean).map(real).filter(Boolean);

// The prompt channel's durable spills: `<project root>/.claude/slim/prompt/slim-prompt-*`.
const PROMPT_DIR_TAIL = path.join('.claude', 'slim', 'prompt');
const PROMPT_SPILL_NAME = /^slim-prompt-[0-9a-f]{16}(?:-[0-9a-f]{8})?\.(?:json|txt)$/;
const isPromptSpill = (file, name) => name.test(path.basename(file)) && path.dirname(file).endsWith(path.sep + PROMPT_DIR_TAIL);

// A path that is one of the plugins' own spills, or a host tool-results file of any session: reading
// one is how the model follows a handle, so it always passes through.
function isSpillOrHostFile(p) {
  const file = typeof p === 'string' ? real(p) : null;
  if (!file) return false;
  if (/^fnd-[\w.-]+$/.test(path.basename(file)) && spillDirs().includes(path.dirname(file))) return true;
  if (isPromptSpill(file, /^slim-prompt-[\w.-]+$/)) return true;
  const segs = projectSegs(file);
  return !!segs && segs.length === 4 && segs[2] === 'tool-results';
}

// A handle naming a regular file this user owns: a whole-original spill in a spill dir or the prompt
// channel's durable dir, or this session's host tool-results file.
function trustedHandle(file, sessionId) {
  if (!path.isAbsolute(file)) return false;
  let st;
  try { st = fs.lstatSync(file); } catch (_) { return false; }
  if (!st.isFile() || !owned(st)) return false;
  if (PROMPT_SPILL_NAME.test(path.basename(file))) { const r = real(file); return !!r && isPromptSpill(r, PROMPT_SPILL_NAME); }
  if (!SPILL_NAME.test(path.basename(file))) return !!hostFile(file, sessionId).file;
  return spillDirs().includes(real(path.dirname(file)));
}

const unlinkAll = (paths) => { for (const p of paths) { try { fs.unlinkSync(p); } catch (_) {} } };

module.exports = { NAMES, PROMPT_DIR_TAIL, writePart, writeOriginal, sweep, hostFile, readHost, readLocal, isSpillOrHostFile, trustedHandle, unlinkAll, SWEEP_MARKER };
