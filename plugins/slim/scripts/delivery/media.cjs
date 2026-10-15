// The media backend: runs the plan engines/media.cjs makes, with whatever the machine already has —
// ffprobe + ffmpeg on PATH (images and video), else `sips` (images only; macOS). No backend → an
// honest refusal, never a new dependency. Outputs land beside the input, and only at the path the
// caller's Write permission check ruled on (`allowedOut`). The view tool's hooks module may first leave
// PLACEHOLDER there through the host's Write tool; clearPlaceholder() removes it before the backend runs.
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const media = require('../engines/media.cjs');

const NO_BACKEND = 'media: no backend (install ffmpeg)';
const HEAD_BYTES = 64;
const PROBE_TIMEOUT_MS = 10000;
const IMAGE_TIMEOUT_MS = 30000;
const VIDEO_TIMEOUT_MS = 100000;
const FRAME_NAME = /^\d{3}\.jpg$/;
// Marks a frames folder slim made, so a re-run clears only its own frames, never a user's folder.
const FRAMES_MARK = '.slim-frames';
const SIPS_FORMAT = { png: 'png', jpg: 'jpeg', jpeg: 'jpeg', gif: 'gif' };
// The whole body the hooks module's host Write puts at the first output (hooks/mods/view.ts keeps the same text).
const PLACEHOLDER = 'slim media placeholder';

function which(name, env) {
  for (const dir of String((env && env.PATH) || '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, name);
    try { fs.accessSync(p, fs.constants.X_OK); if (fs.statSync(p).isFile()) return p; } catch (_) {}
  }
  return null;
}

// { name: 'ffmpeg', ffmpeg, ffprobe } | { name: 'sips', sips } | null, from `env.PATH` only.
function backend(env) {
  const ffmpeg = which('ffmpeg', env);
  const ffprobe = which('ffprobe', env);
  if (ffmpeg && ffprobe) return { name: 'ffmpeg', ffmpeg, ffprobe };
  const sips = which('sips', env);
  return sips ? { name: 'sips', sips } : null;
}

function headOf(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const b = Buffer.alloc(HEAD_BYTES);
    return b.subarray(0, fs.readSync(fd, b, 0, HEAD_BYTES, 0));
  } catch (_) {
    return null;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch (_) {}
  }
}

function exec(bin, args, env, timeout) {
  const r = spawnSync(bin, args, { env, timeout, encoding: 'utf8', maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const err = r.error ? r.error.code || r.error.message : r.status !== 0 ? (String(r.stderr || '').trim().split('\n')[0] || `exit ${r.status}`) : null;
  return { ok: !err, out: String(r.stdout || ''), err };
}

// { width, height, durationS?, rotation? } (stored dimensions) or null. ffmpeg applies a display
// matrix or EXIF orientation before any filter; the first decoded frame's side data reveals it.
function probe(be, file, env, timeoutMs) {
  const timeout = timeoutMs || PROBE_TIMEOUT_MS;
  if (be.name === 'ffmpeg') {
    const r = exec(be.ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-read_intervals', '%+#1', '-show_entries',
      'stream=width,height,duration:stream_side_data=rotation:frame_side_data=rotation:format=duration', '-of', 'json', file], env, timeout);
    if (!r.ok) return null;
    try {
      const j = JSON.parse(r.out);
      const s = (j.streams || [])[0] || {};
      const d = Number((j.format || {}).duration);
      const rotation = [s, (j.frames || [])[0] || {}].flatMap((x) => x.side_data_list || []).map((x) => Number(x.rotation)).find(Number.isFinite) || 0;
      return { width: Number(s.width), height: Number(s.height), durationS: Number.isFinite(d) && d > 0 ? d : Number(s.duration), rotation };
    } catch (_) { return null; }
  }
  const r = exec(be.sips, ['-g', 'pixelWidth', '-g', 'pixelHeight', file], env, timeout);
  const w = /pixelWidth:\s*(\d+)/.exec(r.out);
  const h = /pixelHeight:\s*(\d+)/.exec(r.out);
  return r.ok && w && h ? { width: Number(w[1]), height: Number(h[1]) } : null;
}

const longEdge = (p) => Math.max(p.scale.w, p.scale.h);
// A box fit, not explicit W:H: the frame is already turned upright when the filter sees it.
const fitBox = (p) => `scale=${longEdge(p)}:${longEdge(p)}:force_original_aspect_ratio=decrease`;

function imageArgs(be, p, file, out, ext) {
  if (be.name === 'sips') {
    return [...['-s', 'format', SIPS_FORMAT[ext] || 'png'], ...(p.resized ? ['-Z', String(longEdge(p))] : []), file, '--out', out];
  }
  return ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', file, '-map_metadata', '-1',
    ...(p.resized ? ['-vf', fitBox(p)] : []),
    ...(ext === 'gif' ? [] : ['-frames:v', '1']), ...(ext === 'jpg' || ext === 'jpeg' ? ['-q:v', '3'] : []), out];
}

function videoArgs(be, p, file, dir) {
  const vf = [p.scene ? "select='eq(n,0)+gt(scene,0.3)'" : `fps=1/${p.interval}`, ...(p.resized ? [fitBox(p)] : [])].join(',');
  return ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', file, '-map_metadata', '-1',
    '-vf', vf, ...(p.scene ? ['-fps_mode', 'vfr'] : []), '-frames:v', String(p.outputs.length), '-q:v', '4', path.join(dir, '%03d.jpg')];
}

const sizeOf = (p) => { try { const st = fs.statSync(p); return st.isFile() ? st.size : -1; } catch (_) { return -1; } };
const lstatOf = (p) => { try { return fs.lstatSync(p); } catch (_) { return null; } };
const frameFiles = (dir) => { try { return fs.readdirSync(dir).filter((n) => FRAME_NAME.test(n)).sort(); } catch (_) { return []; } };
const rmQuiet = (p) => { try { fs.unlinkSync(p); } catch (_) {} };
const mtimeOf = (p) => { try { return fs.statSync(p).mtimeMs; } catch (_) { return -1; } };
// A regular file (not a link) newer than `since` whose bytes are an image.
const freshImage = (p, since) => {
  const st = lstatOf(p);
  if (!st || !st.isFile() || !(st.mtimeMs > since)) return false;
  const h = headOf(p);
  const k = h && media.kindOf(h);
  return !!k && k.kind === 'image';
};

// Takes `dir` for this run's frames → { made, marked }, or null when it is a link, a file, or a
// folder holding files slim did not write. Only a folder slim marked has its old NNN.jpg cleared.
function claimFrames(dir) {
  const mark = path.join(dir, FRAMES_MARK);
  const st = lstatOf(dir);
  if (!st) {
    fs.mkdirSync(dir);
    fs.writeFileSync(mark, '');
    return { made: true, marked: true };
  }
  if (!st.isDirectory()) return null;
  const names = fs.readdirSync(dir);
  if (!names.includes(FRAMES_MARK)) {
    if (names.length) return null;
    fs.writeFileSync(mark, '');
    return { made: false, marked: true };
  }
  for (const n of names) if (FRAME_NAME.test(n)) rmQuiet(path.join(dir, n));
  return { made: false, marked: false };
}

/**
 * Removes the file at `out` when it holds PLACEHOLDER alone (surrounding whitespace ignored), then its
 * folder when that is left empty (a video's `<name>.frames/` the host's Write made). Any other file, a
 * link or a folder at `out` stays. Never throws.
 */
function clearPlaceholder(out) {
  if (typeof out !== 'string') return;
  const st = lstatOf(out);
  if (!st || !st.isFile() || st.size > 64) return;
  try { if (fs.readFileSync(out, 'utf8').trim() !== PLACEHOLDER) return; } catch (_) { return; }
  rmQuiet(out);
  try { fs.rmdirSync(path.dirname(out)); } catch (_) {}
}

/**
 * The outputs an earlier run left where plan `p` puts them, or null: an image copy newer than `file`
 * whose long edge fits `cap`, or the frames in a folder slim marked, each newer than `file`.
 */
function reusable(be, p, file, base, env, timeout, cap) {
  const since = mtimeOf(file);
  if (p.kind === 'image') {
    const out = path.join(base, p.outputs[0].rel);
    if (!freshImage(out, since)) return null;
    const d = probe(be, out, env, timeout);
    return d && Math.max(d.width, d.height) <= cap ? [{ path: out, bytes: sizeOf(out) }] : null;
  }
  const dir = path.join(base, p.dir);
  const st = lstatOf(dir);
  if (!st || !st.isDirectory() || !lstatOf(path.join(dir, FRAMES_MARK))) return null;
  const names = frameFiles(dir).slice(0, p.outputs.length);
  if (!names.length || !names.every((n) => freshImage(path.join(dir, n), since))) return null;
  return names.map((n, i) => ({ path: path.join(dir, n), bytes: sizeOf(path.join(dir, n)), ...(p.scene ? {} : { t: p.outputs[i].t }) }));
}

const secs = (t) => `${Math.round(t * 10) / 10}s`;
function describe(kind, facts, p, be, reused) {
  const dims = `${p.source.w}×${p.source.h}`;
  if (reused) return `${kind} ${facts.format} ${kind === 'video' ? `${secs(facts.durationS)} ` : ''}${dims} → the ${kind === 'image' ? 'copy' : 'frames'} an earlier view made, newer than the input`;
  const to = `${p.scale.w}×${p.scale.h}`;
  const meta = be.name === 'sips' ? 'metadata kept (sips cannot strip it)' : 'metadata stripped';
  if (kind === 'image' && p.same) return `image ${facts.format} ${dims}, not re-encoded (${be.name})`;
  if (kind === 'image') return `image ${facts.format} ${dims} → ${p.resized ? to : `${dims} (no resize)`}, ${meta} (${be.name})`;
  const how = p.scene ? 'at scene changes' : `every ${secs(p.interval)}`;
  return `video ${facts.format} ${secs(facts.durationS)} ${dims} → frames ${how} at ${to} (${be.name})`;
}

/**
 * normalize(file, { allowedOut, env, longEdge, everyS, maxFrames, scene, timeoutMs, reuse }) →
 *   { decision: 'compressed'|'passthrough'|'cached'|'refused', reason?, figure, text, kind?, format?, backend?, bytesIn,
 *     bytesOut, frames, outputs: [{ path, bytes, t? }] }
 * `allowedOut` is the path the caller's Write check allowed; it must equal the first output
 * (engines/media.cjs target(): `<dir>/<name>.<longEdge>.<ext>` or `<dir>/<name>.frames/001.jpg`),
 * else nothing is spawned or written. An image the plan passes as itself (`same`) is its own output,
 * nothing written. `reuse` writes nothing: the outputs an earlier run left (reusable()) come back as
 * `cached`, else the refusal `not-reused`; an image that is its own output is still `passthrough`.
 * `timeoutMs` bounds probe and run together (default 30 s for an image, 100 s for a video). `figure`
 * is the media figure line, or the refusal in one line. `text` ends with the line `Read <path>`
 * naming the one image to read. Never throws.
 */
function normalize(file, opts) {
  const o = opts || {};
  const env = o.env || process.env;
  const refuse = (reason, figure, extra) => ({ decision: 'refused', reason, figure, text: figure, bytesIn: 0, bytesOut: 0, frames: 0, outputs: [], ...extra });
  try {
    const bytesIn = sizeOf(file);
    const head = bytesIn > 0 ? headOf(file) : null;
    if (!head) return refuse('unreadable', `media: cannot read ${file}`);
    const k = media.kindOf(head);
    if (!k) return refuse('not-media', 'media: not an image or video slim can read (png, jpeg, gif, webp, mp4, mov, webm, mkv, avi)');
    const known = { kind: k.kind, format: k.format, bytesIn };
    const be = backend(env);
    if (!be || (k.kind === 'video' && be.name !== 'ffmpeg')) return refuse('no-backend', NO_BACKEND, known);
    const base = path.dirname(file);
    const ext = path.extname(file).slice(1);
    const name = path.basename(file, path.extname(file));
    const first = path.join(base, media.target({ kind: k.kind, name, ext }, { longEdge: o.longEdge }));
    if (typeof o.allowedOut !== 'string' || path.resolve(o.allowedOut) !== path.resolve(first)) {
      return refuse('write-denied', `media: writing ${first} is not permitted`, known);
    }
    const deadline = Date.now() + (o.timeoutMs || (k.kind === 'video' ? VIDEO_TIMEOUT_MS : IMAGE_TIMEOUT_MS));
    const left = () => Math.max(1, deadline - Date.now());
    const withBe = { ...known, backend: be.name };
    const pr = probe(be, file, env, Math.min(PROBE_TIMEOUT_MS, left()));
    const facts = { kind: k.kind, format: k.format, name, ext, ...pr };
    const p = pr ? media.plan(facts, { longEdge: o.longEdge, everyS: o.everyS, maxFrames: o.maxFrames, scene: o.scene }) : { refused: 'no-probe' };
    if (p.refused === 'copy-unfit') return refuse(p.refused, `media: ${path.basename(file)} is named like slim's copy but needs one — rename it; not overwritten`, withBe);
    if (p.refused) return refuse(p.refused, `media: ${be.name} could not measure ${path.basename(file)}`, withBe);
    let outputs;
    let err = null;
    const reused = o.reuse === true && !p.same;
    if (reused) {
      outputs = reusable(be, p, file, base, env, Math.min(PROBE_TIMEOUT_MS, left()), Number.isInteger(o.longEdge) && o.longEdge > 0 ? o.longEdge : media.LONG_EDGE);
      if (!outputs) return refuse('not-reused', `media: no output of an earlier view newer than ${path.basename(file)} at ${first}`, withBe);
    } else if (p.same) outputs = [{ path: file, bytes: bytesIn }];
    else if (k.kind === 'image') {
      const out = path.join(base, p.outputs[0].rel);
      const st = lstatOf(out);
      if (st && !st.isFile()) return refuse('out-taken', `media: ${out} is a link or a folder, not written`, withBe);
      const r = exec(be.name === 'sips' ? be.sips : be.ffmpeg, imageArgs(be, p, file, out, path.extname(out).slice(1)), env, left());
      const bytes = sizeOf(out);
      if (!r.ok || bytes <= 0) { err = r.err || 'no output'; rmQuiet(out); } else outputs = [{ path: out, bytes }];
    } else {
      const dir = path.join(base, p.dir);
      const claim = claimFrames(dir);
      if (!claim) return refuse('out-taken', `media: ${dir} holds files slim did not write`, withBe);
      const r = exec(be.ffmpeg, videoArgs(be, p, file, dir), env, left());
      const names = frameFiles(dir).slice(0, p.outputs.length);
      outputs = names.map((n, i) => ({ path: path.join(dir, n), bytes: sizeOf(path.join(dir, n)), ...(p.scene ? {} : { t: p.outputs[i].t }) }));
      if (!r.ok || !outputs.length) {
        err = r.err || 'no frames';
        for (const n of frameFiles(dir)) rmQuiet(path.join(dir, n));
        if (claim.marked) rmQuiet(path.join(dir, FRAMES_MARK));
        if (claim.made) try { fs.rmdirSync(dir); } catch (_) {}
      }
    }
    if (err) return refuse('backend-failed', `media: ${be.name} failed on ${path.basename(file)}: ${err}`, withBe);
    const bytesOut = outputs.reduce((s, x) => s + x.bytes, 0);
    const lines = k.kind === 'image' ? [`Read ${outputs[0].path}${p.same ? '' : ' once to see it'}`]
      : outputs.map((x) => (x.t === undefined ? x.path : `${x.path}  t=${secs(x.t)}`));
    return {
      decision: p.same ? 'passthrough' : reused ? 'cached' : 'compressed',
      figure: p.same ? media.sameLine(bytesIn, o.longEdge) : media.figureLine(bytesIn, bytesOut, outputs.length),
      text: [describe(k.kind, facts, p, be, reused), ...lines].join('\n'),
      kind: k.kind, format: k.format, backend: be.name, bytesIn, bytesOut, frames: outputs.length, outputs,
    };
  } catch (e) {
    return refuse('error', `media: ${(e && e.code) || (e && e.message) || 'failed'}`);
  }
}

module.exports = { normalize, clearPlaceholder, backend, probe, headOf, NO_BACKEND, PLACEHOLDER };
