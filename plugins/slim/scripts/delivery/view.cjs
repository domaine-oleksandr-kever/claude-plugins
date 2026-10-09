// The view tool's core (`slim.cjs --view`): one file, command output or host file in, its compact
// text out — narrowed by jq first when asked, then the engine the content sniffs as (or the one the
// caller named); an image or a video goes to the media backend instead. With `out` the compact text
// comes back as a `write` for the hooks module to put through the host's Write tool, headed by a
// marker line that lets the next call over the same input answer `cached`.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const env = require('./env.cjs');
const spill = require('./spill.cjs');
const emit = require('./emit.cjs');
const rep = require('./report.cjs');
const mediaD = require('./media.cjs');
const mediaE = require('../engines/media.cjs');
const figmaNodes = require('../engines/figma-nodes.cjs');
const jq = require('../engines/jq.cjs');
const { compress, sniff, ENGINES: ENGINE_IDS } = require('../engines/index.cjs');

const TOOL = 'mcp__slim__view';
// The reply shows text up to this size whole; past it, the head and a file to Read windowed.
const VIEW_INLINE = 16384;
// What JSON is fitted to when it goes to `out`: the read channel's egress, so the file stays a view.
const OUT_TARGET = 65536;
const MARK = /^<<slim view k=([0-9a-f]{12}) engine=([\w-]+) v=([\w.+-]+)>>$/;

const utf8 = (s) => Buffer.byteLength(s, 'utf8');
const real = (p) => { try { return fs.realpathSync(p); } catch (_) { return null; } };
const lstat = (p) => { try { return fs.lstatSync(p); } catch (_) { return null; } };

let versionMemo = null;
function pluginVersion() {
  if (versionMemo) return versionMemo;
  try {
    const v = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '.claude-plugin', 'plugin.json'), 'utf8')).version;
    versionMemo = typeof v === 'string' && /^[\w.+-]+$/.test(v) ? v : '0';
  } catch (_) { versionMemo = '0'; }
  return versionMemo;
}

// The request's identity for the cache: the input, the narrowing and the engine asked for.
const keyOf = (file, jqSrc, engine) => crypto.createHash('sha256').update(JSON.stringify([file, jqSrc || '', engine || 'auto'])).digest('hex').slice(0, 12);
const markLine = (key, engine) => `<<slim view k=${key} engine=${engine} v=${pluginVersion()}>>`;

// `p` with its deepest existing ancestor resolved through links: where a write there would land.
function landing(p) {
  const rest = [];
  let dir = p;
  while (!fs.existsSync(dir)) {
    const up = path.dirname(dir);
    if (up === dir) return null;
    rest.unshift(path.basename(dir));
    dir = up;
  }
  const base = real(dir);
  return base ? path.join(base, ...rest) : null;
}

const inside = (root, p, minSegs) => {
  if (!root) return false;
  const rel = path.relative(root, p);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel) && rel.split(path.sep).length >= minSegs;
};

const tasksOf = (dir) => (typeof dir === 'string' && path.isAbsolute(dir) ? landing(path.join(dir, '.claude', 'tasks')) : null);

/**
 * The `out` path a view may write → { path, exists } or { why }. Accepted only under
 * `<root>/.claude/tasks/<id>/`, `<cwd>/.claude/tasks/<id>/` (a repo below the session root) or slim's
 * spill root, as a regular file that is not the input.
 */
function outTarget(out, root, cwd, input) {
  if (typeof out !== 'string' || !out.trim() || /[\\/]$/.test(out)) return { why: 'out-not-file' };
  const abs = path.resolve(cwd || process.cwd(), out);
  const at = landing(abs);
  if (!at) return { why: 'out-outside-roots' };
  const spillRoot = landing(path.resolve(env.spillRoot()));
  if (!inside(tasksOf(root), at, 2) && !inside(tasksOf(cwd), at, 2) && !inside(spillRoot, at, 1)) return { why: 'out-outside-roots' };
  const st = lstat(at);
  if (st && !st.isFile()) return { why: 'out-taken' };
  if (input && at === input) return { why: 'out-is-input' };
  return { path: at, exists: !!st };
}

// The out file still answers this request: newer than the input, headed by this request's marker, and
// every part it cites still on disk (parts live in the spill root, which the sweep empties).
function cachedOut(target, file, key) {
  if (!target.exists) return null;
  let st;
  let src;
  try { st = fs.statSync(target.path); src = fs.statSync(file); } catch (_) { return null; }
  if (!(st.mtimeMs > src.mtimeMs)) return null;
  const f = spill.readLocal(target.path);
  if (!f.file) return null;
  const nl = f.text.indexOf('\n');
  const m = MARK.exec(nl === -1 ? f.text : f.text.slice(0, nl));
  if (!m || m[1] !== key || m[3] !== pluginVersion()) return null;
  const text = nl === -1 ? '' : f.text.slice(nl + 1);
  for (const h of text.matchAll(/<<full=([^\s>]+)/g)) if (!fs.existsSync(h[1])) return null;
  return { engine: m[2], text, lines: f.text.split('\n').length, bytesIn: src.size };
}

// Figma's REST tooling writes `<key>.variables.json` beside `<key>-<node>.nodes.json`.
function variablesFor(file) {
  const m = /^([A-Za-z0-9]+)-.+\.nodes\.json$/.exec(path.basename(file));
  if (!m) return undefined;
  const f = spill.readLocal(path.join(path.dirname(file), `${m[1]}.variables.json`));
  if (!f.file) return undefined;
  try { const v = JSON.parse(f.text); return v && typeof v === 'object' && !Array.isArray(v) ? v : undefined; } catch (_) { return undefined; }
}

const isSpillOrHost = (p) => { try { return spill.isSpillOrHostFile(p); } catch (_) { return false; } };

/**
 * One view request → the reply the hooks module turns into the tool's text.
 * request: { v:1, path? | text? | host_path?, command?, jq?, engine?, out?, media?, allowed_out?, root, cwd, session_id }
 * (`media` or `allowed_out` makes it media-only: a path whose bytes are not an image or a video is refused)
 * reply:   { v:1, decision: 'compressed'|'narrowed'|'passthrough'|'cached'|'refused', reason?, engine,
 *            figure, text, bytesIn, bytesOut, stages, narrowed?, out?, lines?, write?: { path, marker, exists },
 *            pointer?, original?, outputs?, frames? }
 * opts: { engineOptions, created } — `engineOptions` are compress()'s (spill names and dir, budget);
 * `created` collects the files this call wrote, for the caller to drop when the reply is not sent.
 */
function view(input, opts) {
  const o = opts || {};
  const created = o.created || [];
  const refuse = (reason, message, x) => ({ v: 1, decision: 'refused', reason, engine: null, figure: message.split('\n')[0], text: message, bytesIn: 0, bytesOut: 0, stages: [], ...x });
  const engine = typeof input.engine === 'string' && input.engine ? input.engine : null;
  if (engine && engine !== 'media' && !ENGINE_IDS.includes(engine)) return refuse('bad-engine', `view: unknown engine '${String(engine).slice(0, 32)}' — one of ${[...ENGINE_IDS, 'media'].join(', ')}`);
  const jqSrc = typeof input.jq === 'string' && input.jq.trim() ? input.jq : null;
  const hasOut = typeof input.out === 'string' && input.out.trim() !== '';

  let text;
  let file = null;
  let original = null;
  if (typeof input.path === 'string') {
    file = real(path.resolve(input.cwd || process.cwd(), input.path));
    if (!file) return refuse('expand-missing', `view: cannot read ${input.path}`);
    if (isSpillOrHost(file)) rep.appendLine({ src: 'slim', channel: 'view', entry: 'access', via: 'view', tool: TOOL, spill: file }, input.cwd);
    const head = mediaD.headOf(file);
    const kind = head && mediaE.kindOf(head);
    // A media request never falls back to text: the Read probe that guards a text view did not run.
    if (engine === 'media' || input.media === true || typeof input.allowed_out === 'string' || kind) {
      if (!kind) return refuse('not-media', `view: ${input.path} is not an image or a video`);
      if (jqSrc || hasOut) return refuse('media-args', 'view: jq and out do not apply to an image or a video — its outputs land beside the input');
      // The check ruled on the path as given; a linked folder on the way (macOS /tmp) lands in the same place.
      const allowedOut = typeof input.allowed_out === 'string' ? landing(path.resolve(input.cwd || process.cwd(), input.allowed_out)) : undefined;
      const m = mediaD.normalize(file, { allowedOut, env: process.env });
      const x = { engine: 'media', bytesIn: m.bytesIn, bytesOut: m.bytesOut, frames: m.frames, outputs: m.outputs };
      if (m.decision !== 'compressed') return refuse(m.reason, m.figure, x);
      return { v: 1, decision: 'compressed', ...x, figure: m.figure, text: m.text, stages: [] };
    }
    const f = spill.readLocal(file);
    if (!f.file) return refuse(f.why, `view: cannot read ${input.path} (${f.why})`);
    text = f.text;
  } else if (typeof input.host_path === 'string') {
    const h = spill.readHost(input.host_path, input.session_id);
    if (!h.file) return refuse(h.why, `view: the command's saved output cannot be read (${h.why})`);
    text = h.text;
    original = h.file;
  } else if (typeof input.text === 'string') {
    text = input.text;
  } else return refuse('bad-input', 'view: give exactly one of path or command');
  if (engine === 'media') return refuse('not-media', 'view: engine media needs a path to an image or a video');

  let target = null;
  if (hasOut) {
    target = outTarget(input.out, input.root, input.cwd, file);
    if (target.why) {
      const why = target.why === 'out-outside-roots'
        ? `view: out must be under .claude/tasks/<id>/ of the session root or the working directory, or slim's spill root (${env.spillRoot()})`
        : target.why === 'out-taken' ? `view: out ${input.out} is a folder or a link, not a file`
          : target.why === 'out-is-input' ? 'view: out cannot be the input itself' : `view: out ${input.out} is not a file path`;
      return refuse(target.why, why);
    }
  }
  const key = keyOf(file || `command:${input.command || ''}`, jqSrc, engine);
  if (target && file) {
    const c = cachedOut(target, file, key);
    if (c) {
      return { v: 1, decision: 'cached', engine: c.engine, figure: 'cached', text: c.text, bytesIn: c.bytesIn, bytesOut: utf8(c.text), stages: [], out: target.path, lines: c.lines, pointer: target.path };
    }
  }

  const bytesIn = utf8(text);
  let body = text;
  let narrowed = false;
  if (jqSrc) {
    const n = jq.narrow(text, jqSrc);
    if (n.decision === 'refused') return refuse(n.reason, n.message);
    if (n.decision === 'narrowed') { body = n.text; narrowed = true; }
  }

  const hint = {};
  if (file) { hint.filename = path.basename(file); const vars = variablesFor(file); if (vars) hint.variables = vars; }
  if (typeof input.command === 'string') hint.source = input.command.slice(0, 2000);
  let r = null;
  if (!narrowed || utf8(body) > VIEW_INLINE) {
    // JSON is fitted to what the reader can take (dropped rows go to a part): the reply, or the out file.
    // A node tree is not: a long text is read windowed from a file, so no level of it is folded away.
    const kind = engine || (narrowed ? 'json' : sniff({ data: body }).engine);
    r = compress({ data: body, hint }, { ...o.engineOptions, engine: narrowed ? (engine || 'json') : engine, targetBytes: kind === 'figma-nodes' ? null : target ? OUT_TARGET : VIEW_INLINE });
    if (r.decision === 'refused') return refuse(r.reason || 'refused', `view: ${r.reason === 'binary' ? 'the source is binary (not text, an image or a video)' : `the engines refused the source (${r.reason})`}`);
  }
  const compressed = !!r && r.decision === 'compressed';
  const final = compressed ? r.text : body;
  const usedEngine = r ? (r.engine === 'none' ? 'text' : r.engine) : 'json';
  const bytesOut = utf8(final);
  const stages = compressed ? r.stats.stages : [];

  for (const p of (compressed && r.parts) || []) {
    const w = spill.writePart(p.suggestedName, p.payload);
    if (!w) return refuse('spill-write-failure', 'view: a part the compact text cites could not be written');
    if (w.created) created.push(w.path);
  }
  let figure;
  if (narrowed) {
    figure = `slim view: narrowed by jq to ${emit.commas(utf8(body))} B of a ${emit.commas(bytesIn)} B source${compressed ? `, compressed to ${emit.commas(bytesOut)} B` : ''} (no saving figure: jq changed the measured object)`;
  } else if (compressed && usedEngine === 'figma-nodes') {
    figure = figmaNodes.figureLine(bytesIn, bytesOut, r.meta);
  } else if (compressed) {
    figure = emit.statsLine('compressed', bytesIn, bytesOut);
  } else {
    figure = `slim view: ${emit.commas(bytesIn)} B, not compressed (${(r && r.reason) || 'small'})`;
  }
  const reply = {
    v: 1, decision: narrowed ? 'narrowed' : compressed ? 'compressed' : 'passthrough', ...(r && !compressed && r.reason ? { reason: r.reason } : {}),
    engine: usedEngine, figure, text: final, bytesIn, bytesOut, stages, ...(narrowed ? { narrowed: true } : {}),
  };
  // A command's output is gone once the call returns: a compressed view keeps the original on disk.
  if (compressed && !file) {
    if (!original) {
      const s = spill.writeOriginal(text, ['json', 'jsonl', 'figma-nodes', 'adf'].includes(usedEngine) ? '.json' : '.txt');
      if (!s) return refuse('spill-write-failure', 'view: the original output could not be kept');
      if (s.created) created.push(s.path);
      original = s.path;
    }
    reply.original = original;
  }
  if (target) {
    // The text travels once: the hooks module writes `marker`, a newline, then `text`.
    return { ...reply, out: target.path, lines: final.split('\n').length + 1, write: { path: target.path, marker: markLine(key, usedEngine), exists: target.exists }, pointer: target.path };
  }
  if (bytesOut > VIEW_INLINE) {
    if (!compressed && !narrowed && file) return { ...reply, pointer: file };
    const s = spill.writeOriginal(final, '.txt');
    if (!s) return refuse('spill-write-failure', 'view: the compact text could not be kept for a windowed Read');
    if (s.created) created.push(s.path);
    return { ...reply, pointer: s.path };
  }
  return reply;
}

module.exports = { view, outTarget, VIEW_INLINE, OUT_TARGET, TOOL };
