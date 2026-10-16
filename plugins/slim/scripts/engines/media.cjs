/*
 * engines/media.cjs — media planning: what an image or a video becomes before the model sees it.
 *
 * Not a compress() engine: media is binary and compress() refuses binary. This module only decides
 * — the kind from the leading bytes, the outputs (names, scale, frame count and interval) from the
 * probe facts a backend measured, and the figure line. Running a backend is the caller's job
 * (delivery/media.cjs). Pure.
 */
'use strict';

const LONG_EDGE = 1568;
const EVERY_S = 2;
const MAX_FRAMES = 24;
const MAX_BYTES = 150 * 1024;
const QUALITY = 60;
// The long edges an image copy over MAX_BYTES steps down through, below the first fit.
const STEP_EDGES = [1280, 1024, 800, 640];

const at = (b, off, sig) => sig.every((v, i) => b[off + i] === v);
const ascii = (b, from, to) => (b.length >= to ? b.toString('latin1', from, to) : '');
// ISO-BMFF brands that hold a still image, not a movie.
const STILL_BRANDS = /^(heic|heix|hevc|heim|heis|mif1|msf1|avif|avis)$/;

// kindOf(head) → { kind: 'image'|'video', format } from the first bytes of a file (64 are enough), or null.
function kindOf(head) {
  const b = Buffer.isBuffer(head) ? head : Buffer.alloc(0);
  if (at(b, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { kind: 'image', format: 'png' };
  if (at(b, 0, [0xff, 0xd8, 0xff])) return { kind: 'image', format: 'jpeg' };
  if (ascii(b, 0, 4) === 'GIF8') return { kind: 'image', format: 'gif' };
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP') return { kind: 'image', format: 'webp' };
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'AVI ') return { kind: 'video', format: 'avi' };
  if (ascii(b, 4, 8) === 'ftyp') {
    const brand = ascii(b, 8, 12);
    if (STILL_BRANDS.test(brand)) return null;
    return { kind: 'video', format: brand === 'qt  ' ? 'mov' : 'mp4' };
  }
  if (at(b, 0, [0x1a, 0x45, 0xdf, 0xa3])) return { kind: 'video', format: b.includes('webm', 0, 'latin1') ? 'webm' : 'mkv' };
  return null;
}

const posInt = (v) => Number.isFinite(v) && v > 0 && Math.floor(v) === v;
const posNum = (v) => Number.isFinite(v) && v > 0;
// Every image copy is a JPEG, whatever the input format: the name alone predicts the output path.
const OUT_EXTS = new Set(['jpg', 'jpeg']);
const longEdgeOf = (o) => (posInt(o.longEdge) ? o.longEdge : LONG_EDGE);
const frameRel = (dir, i) => `${dir}/${String(i + 1).padStart(3, '0')}.jpg`;
// A name target() gives: the copy is its own output, never `<stem>.1568.1568.jpg`.
const isCopy = (f, longEdge) => f.name.endsWith(`.${longEdge}`) && OUT_EXTS.has(String(f.ext || '').toLowerCase());
const selfRel = (f) => (f.ext ? `${f.name}.${f.ext}` : f.name);
// The formats a reader opens by extension; a mismatched or missing one would be sent as the wrong type.
const EXT_FORMAT = { png: 'png', jpg: 'jpeg', jpeg: 'jpeg', gif: 'gif', webp: 'webp' };

// target(facts, opts) → the first output's path relative to the input's directory, from `kind`,
// `name` and `ext` only (no probe needed): the path a caller's Write check must rule on; an image
// already named `<stem>.<longEdge>.<jpg|jpeg>` is its own target. null when kind or name is missing.
function target(facts, opts) {
  const f = facts || {};
  if (typeof f.name !== 'string' || !f.name) return null;
  const longEdge = longEdgeOf(opts || {});
  if (f.kind === 'image') return isCopy(f, longEdge) ? selfRel(f) : `${f.name}.${longEdge}.jpg`;
  return f.kind === 'video' ? frameRel(`${f.name}.frames`, 0) : null;
}

// Long edge capped, aspect kept, never upscaled.
function fit(width, height, longEdge) {
  const long = Math.max(width, height);
  if (long <= longEdge) return { w: width, h: height, resized: false };
  const s = longEdge / long;
  return { w: Math.max(1, Math.round(width * s)), h: Math.max(1, Math.round(height * s)), resized: true };
}

/**
 * plan(facts, opts) → the outputs to produce, or { refused }.
 * facts: { kind, format, name, ext, width, height, durationS, rotation, bytes } — `name` is the input's
 *   basename without its extension; width × height are the stored dimensions, and a quarter-turn
 *   `rotation` (degrees, from the display matrix or EXIF) swaps them to the displayed ones; outputs
 *   are paths relative to the input's directory; `bytes` is the input's size (absent: under the cap).
 * opts: { longEdge = 1568, everyS = 2, maxFrames = 24, scene = false, maxBytes = 150 KB }.
 * image → { kind, outputs: [{ rel }], source: { w, h }, scale: { w, h }, resized, same, steps,
 *   quality, maxBytes } — `source` is the displayed size, `scale` the first step's size. `same`: the
 *   input is its own output (rel is its basename, nothing to write) when it fits the long edge, is
 *   upright, its extension names its format and it is within maxBytes (a copy target() named needs
 *   no byte check: it is final); else rel is target(facts, opts), a JPEG at `quality`. `steps`
 *   [{ longEdge, w, h, resized }]: the first fits the long edge, the rest step down while the
 *   encoded copy stays over maxBytes; the last is kept even over it. An animated GIF keeps its first
 *   frame. A name target() gives that is not `same` → { refused: 'copy-unfit' }.
 * video → { kind, dir: '<name>.frames', outputs: [{ rel, t }], source, scale, resized, interval,
 *   scene } — interval frames at t = 0, interval, …; when ceil(duration / everyS) exceeds
 *   maxFrames the interval widens to duration / maxFrames so the frames still span the whole clip.
 *   Scene mode lists the most it may write (maxFrames) with t = null; the backend writes as many as
 *   the cuts give.
 */
function plan(facts, opts) {
  const f = facts || {};
  const o = opts || {};
  const longEdge = longEdgeOf(o);
  const everyS = posNum(o.everyS) ? o.everyS : EVERY_S;
  const maxFrames = posInt(o.maxFrames) ? o.maxFrames : MAX_FRAMES;
  if (f.kind !== 'image' && f.kind !== 'video') return { refused: 'not-media' };
  if (typeof f.name !== 'string' || !f.name || !posInt(f.width) || !posInt(f.height)) return { refused: 'no-probe' };
  const turned = Math.abs(Math.round(Number(f.rotation) || 0)) % 180 === 90;
  const source = turned ? { w: f.height, h: f.width } : { w: f.width, h: f.height };
  const { w, h, resized } = fit(source.w, source.h, longEdge);
  if (f.kind === 'image') {
    const maxBytes = posInt(o.maxBytes) ? o.maxBytes : MAX_BYTES;
    const copy = isCopy(f, longEdge);
    const same = !resized && !Number(f.rotation) && EXT_FORMAT[String(f.ext || '').toLowerCase()] === f.format && (copy || !(f.bytes > maxBytes));
    if (!same && copy) return { refused: 'copy-unfit' };
    const first = Math.max(w, h);
    const steps = [first, ...STEP_EDGES.filter((e) => e < first)].map((e) => ({ longEdge: e, ...fit(source.w, source.h, e) }));
    return { kind: 'image', outputs: [{ rel: same ? selfRel(f) : target(f, o) }], source, scale: { w, h }, resized, same, steps, quality: QUALITY, maxBytes };
  }
  if (!posNum(f.durationS)) return { refused: 'no-probe' };
  const dir = `${f.name}.frames`;
  if (o.scene) {
    return { kind: 'video', dir, outputs: Array.from({ length: maxFrames }, (_, i) => ({ rel: frameRel(dir, i), t: null })), source, scale: { w, h }, resized, interval: null, scene: true };
  }
  const want = Math.max(1, Math.ceil(f.durationS / everyS));
  const count = Math.min(want, maxFrames);
  const step = want > maxFrames ? f.durationS / maxFrames : everyS;
  const ms = (x) => Math.round(x * 1000) / 1000;
  const outputs = Array.from({ length: count }, (_, i) => ({ rel: frameRel(dir, i), t: ms(i * step) }));
  return { kind: 'video', dir, outputs, source, scale: { w, h }, resized, interval: ms(step), scene: false };
}

// `media: <in> B → <out> B (-NN%) frames=N` — whole percent; `+` when the outputs outweigh the input.
function figureLine(bytesIn, bytesOut, frames) {
  const p = bytesIn > 0 ? Math.round((1 - bytesOut / bytesIn) * 100) : 0;
  return `media: ${bytesIn} B → ${bytesOut} B (${p < 0 ? '+' : '-'}${Math.abs(p)}%) frames=${frames}`;
}

// 900 B, 96 KB, 2.3 MB (1 KB = 1024 B).
const size = (n) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);

// `<in> → <out> (-NN%) · <long edge> px · jpeg[ · <backend>]`: what an image copy saved; the backend
// that wrote it is named unless it is sips or not given.
function shrinkFigure(bytesIn, bytesOut, longEdge, backend) {
  const p = bytesIn > 0 ? Math.round((1 - bytesOut / bytesIn) * 100) : 0;
  return `${size(bytesIn)} → ${size(bytesOut)} (${p < 0 ? '+' : '-'}${Math.abs(p)}%) · ${longEdge} px · jpeg${backend && backend !== 'sips' ? ` · ${backend}` : ''}`;
}

// `view <name>: <shrinkFigure>`: the figure of an image copy.
const imageLine = (name, bytesIn, bytesOut, longEdge, backend) => `view ${name}: ${shrinkFigure(bytesIn, bytesOut, longEdge, backend)}`;

// `view <name>: <in> · <long edge> px — fits, no copy`: the figure of an image that is its own output.
const sameLine = (name, bytesIn, longEdge) => `view ${name}: ${size(bytesIn)} · ${longEdge} px — fits, no copy`;

module.exports = { kindOf, plan, target, figureLine, shrinkFigure, imageLine, sameLine, LONG_EDGE, EVERY_S, MAX_FRAMES, MAX_BYTES, QUALITY };
