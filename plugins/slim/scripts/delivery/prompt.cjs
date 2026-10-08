// The prompt channel's core (`slim.cjs --prompt`): a pasted prompt in, the same prompt out with each
// data-shaped span (JSON, JSON lines, a log, an HTML page, fenced data) replaced in place by its
// compact text, or by its head when the compact text is still too big, each followed by the stats
// line and a handle to the whole span kept in `<project root>/.claude/slim/prompt/`. Prose and the
// question stay byte for byte. That dir is durable on purpose: the rewrite consumed the paste, so the
// spill is the only copy left, and the TTL sweep of the spill root never reaches it. A run that never
// answers (killed at its timeout) leaves a `.pending-*` journal of what it wrote, and the next run
// removes those files; a rewrite the session never took is dropped by the hooks module (`drop`).
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const env = require('./env.cjs');
const spill = require('./spill.cjs');
const emit = require('./emit.cjs');
const { compress, spans: findSpans, jsonBlobs } = require('../engines/index.cjs');

const PROMPT_MIN = 10240;
const SPAN_MIN = 8192;
// A JSON replacement this big would be a parseable span again, so JSON is inlined only below it.
const JSON_INLINE = 8192;
const JSON_TARGET = 6144;
const TEXT_INLINE = 102400;
const HEAD_BYTES = 2048;
const NAMES = { original: 'slim-prompt-', rows: 'slim-prompt-rows-', ids: 'slim-prompt-ids-' };
const PENDING = /^\.pending-[\w-]+$/;
const PENDING_STALE_MS = 10 * 60 * 1000;

const utf8 = (s) => Buffer.byteLength(s, 'utf8');

// A linked worktree is deleted with its ignored files, so durable spills go to its main checkout.
function durableRoot(root) {
  try {
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(path.join(root, '.git'), 'utf8'));
    const wt = path.resolve(root, m[1]);
    const dotGit = path.dirname(path.dirname(wt));
    if (path.basename(path.dirname(wt)) === 'worktrees' && path.basename(dotGit) === '.git') return path.dirname(dotGit);
  } catch (_) {}
  return root;
}

// `<durable root>/.claude/slim/prompt`, created 0700, with a `*` .gitignore in `.claude/slim`; null when
// a component exists and is not a directory (a committed link there would carry the paste into a tracked folder).
function promptDir(root) {
  let dir = durableRoot(root);
  for (const part of spill.PROMPT_DIR_TAIL.split(path.sep)) {
    dir = path.join(dir, part);
    let st = null;
    try { st = fs.lstatSync(dir); } catch (e) { if (e.code !== 'ENOENT') return null; }
    if (st && !st.isDirectory()) return null;
  }
  try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch (_) { return null; }
  // Keeps every paste out of `git add -A` without touching the project's own .gitignore; never overwritten.
  try { fs.writeFileSync(path.join(path.dirname(dir), '.gitignore'), '*\n', { flag: 'wx', mode: 0o600 }); } catch (_) {}
  return dir;
}

const ownSpill = (dir, p) => typeof p === 'string' && path.dirname(p) === dir && /^slim-prompt-[\w.-]+$/.test(path.basename(p));

function unlinkOwn(dir, p, notAfterMs) {
  if (!ownSpill(dir, p)) return;
  try {
    const st = fs.lstatSync(p);
    if (st.isFile() && (notAfterMs === undefined || st.mtimeMs <= notAfterMs)) fs.unlinkSync(p);
  } catch (_) {}
}

// A stale journal's files go with it, except one re-dated since: a later prompt reused those bytes.
function sweepPending(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch (_) { return; }
  const now = Date.now();
  for (const name of names) {
    if (!PENDING.test(name)) continue;
    const j = path.join(dir, name);
    try {
      const st = fs.lstatSync(j);
      if (!st.isFile() || now - st.mtimeMs < PENDING_STALE_MS) continue;
      for (const p of fs.readFileSync(j, 'utf8').split('\n')) unlinkOwn(dir, p, st.mtimeMs);
      fs.unlinkSync(j);
    } catch (_) {}
  }
}

// At most `max` bytes from the top, cut after a line when one ends past a quarter of it.
function headOf(text, max) {
  let out = '';
  let n = 0;
  for (const c of text) {
    const b = utf8(c);
    if (n + b > max) break;
    out += c;
    n += b;
  }
  const nl = out.lastIndexOf('\n');
  return nl > max / 4 ? out.slice(0, nl) : out;
}

const recipe = (kind, bytes) => `[slim: the rest of this pasted ${kind} is in the file below — ${emit.commas(bytes)} B in all; ` +
  `Read it windowed (offset/limit) or call mcp__slim__view({ path${kind === 'json' || kind === 'jsonl' ? ', jq' : ''} })]`;

/**
 * One prompt → the reply the hooks module rewrites it with.
 * input: { v:1, text, root, cwd, session_id }
 * reply: { v:1, decision: 'rewritten'|'passthrough', reason?, text?, engine?, bytesIn, bytesOut,
 *          spans: [{ kind, engine, form: 'inline'|'head', bytes_in, bytes_out, spill }], created? }
 * `run` ({ created: [], journal: null }) collects the files this call wrote and its journal; the
 * caller settles it once the reply is out. `created` in a rewrite is what `drop` takes back.
 */
function rewrite(input, run) {
  const created = run.created;
  const text = typeof input.text === 'string' ? input.text : null;
  const bytesIn = text === null ? 0 : utf8(text);
  const pass = (reason) => ({ v: 1, decision: 'passthrough', reason, bytesIn, bytesOut: bytesIn, spans: [] });
  if (text === null) return pass('bad-input');
  if (bytesIn < PROMPT_MIN) return pass('size-gate');
  const found = findSpans(text, { min: SPAN_MIN });
  if (!found.length) return pass('no-span');
  const root = typeof input.root === 'string' && path.isAbsolute(input.root) ? input.root
    : typeof input.cwd === 'string' && path.isAbsolute(input.cwd) ? input.cwd : null;
  if (!root) return pass('no-root');
  const dir = promptDir(root);
  if (!dir) return pass('spill-dir-refused');
  sweepPending(dir);
  run.journal = path.join(dir, `.pending-${process.pid}-${crypto.randomUUID().slice(0, 8)}`);
  const track = (p) => {
    created.push(p);
    try { fs.appendFileSync(run.journal, `${p}\n`, { mode: 0o600 }); } catch (_) {}
  };

  const budget = env.budgetMs();
  const deadline = budget === 0 ? null : (budget < 0 ? Date.now() - 1 : Date.now() + budget);
  const done = [];
  const stages = [];
  let out = '';
  let at = 0;
  for (const s of found) {
    const body = text.slice(s.start, s.end);
    const spanBytes = utf8(body);
    const jsonish = s.kind === 'json' || s.kind === 'jsonl';
    const maxMs = deadline === null ? 0 : Math.max(-1, deadline - Date.now()) || -1;
    const r = compress({ data: body }, {
      engine: s.kind === 'json' ? null : s.kind, spillDir: dir, spillNames: NAMES, maxMs, plainBytes: env.plainBytes(),
      targetBytes: jsonish ? JSON_TARGET : null, trace: env.debugLevel() > 0,
    });
    const orig = spill.writeOriginal(body, jsonish ? '.json' : '.txt', { dir, prefix: NAMES.original });
    if (!orig) return pass('spill-write-failure');
    if (orig.created) track(orig.path);
    const handle = `<<full=${orig.path} original_result>>`;
    let built = null;
    let form = 'inline';
    if (r.decision === 'compressed') {
      const limit = r.engine === 'json' || r.engine === 'jsonl' ? JSON_INLINE : TEXT_INLINE;
      if (utf8(r.text) < limit) {
        built = emit.withStats((st) => `${r.text}\n\n${st}\n\n${handle}`, 'compressed', spanBytes, utf8);
        if (built.bytes >= spanBytes) built = null;
        else {
          for (const p of r.parts || []) {
            const w = spill.writePart(p.suggestedName, p.payload, dir);
            if (!w) return pass('spill-write-failure');
            if (w.created) track(w.path);
          }
          for (const x of r.stats.stages) if (!stages.includes(x)) stages.push(x);
        }
      }
    }
    if (!built && (jsonish || spanBytes > TEXT_INLINE)) {
      const head = headOf(body, HEAD_BYTES);
      built = emit.withStats((st) => `${head}\n${recipe(s.kind, spanBytes)}\n\n${st}\n\n${handle}`, 'stub', spanBytes, utf8);
      form = 'head';
    }
    if (!built) {
      if (orig.created) { spill.unlinkAll([orig.path]); created.splice(created.indexOf(orig.path), 1); }
      continue;
    }
    out += text.slice(at, s.start) + built.value;
    at = s.end;
    done.push({ kind: s.kind, engine: form === 'head' ? 'stub' : r.engine, form, bytes_in: spanBytes, bytes_out: built.bytes, spill: orig.path });
  }
  if (!done.length) return pass('no-gain');
  out += text.slice(at);
  // The output bound: the rewritten prompt never carries a parseable JSON span of SPAN_MIN or more.
  const left = jsonBlobs(out, SPAN_MIN);
  if (left.bailed || left.blobs.length) return pass('output-bound');
  const main = done.reduce((a, b) => (b.bytes_in > a.bytes_in ? b : a));
  return {
    v: 1, decision: 'rewritten', text: out, engine: main.engine, form: done.every((d) => d.form === 'head') ? 'head' : 'inline',
    bytesIn, bytesOut: utf8(out), stages, spans: done, created: created.slice(),
  };
}

// After the reply is written: a rewrite keeps its files, anything else takes them back; the journal goes.
function settle(run, keep) {
  if (!keep) spill.unlinkAll(run.created);
  if (run.journal) { try { fs.unlinkSync(run.journal); } catch (_) {} }
}

/**
 * `--prompt-drop`: { v:1, root, files } → the files of a rewrite the session never took (the dispatch
 * was interrupted, or a hook beneath dropped the prompt). Only slim-prompt files in that root's
 * prompt dir are removed.
 */
function drop(input) {
  const root = input && typeof input.root === 'string' && path.isAbsolute(input.root) ? input.root : null;
  if (!root || !Array.isArray(input.files)) return;
  const dir = path.join(durableRoot(root), spill.PROMPT_DIR_TAIL);
  for (const p of input.files.slice(0, 64)) unlinkOwn(dir, p);
}

module.exports = { rewrite, settle, drop, durableRoot, promptDir, PROMPT_MIN, SPAN_MIN, NAMES };
