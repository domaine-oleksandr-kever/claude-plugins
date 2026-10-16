/*
 * engines/codec/png.cjs — a PNG decoder to 8-bit RGB, Node built-ins only (zlib).
 *
 * Reads IHDR, PLTE, tRNS and the IDAT stream; colour types 0/2/3/4/6 at every bit depth the spec
 * allows (16-bit keeps the high byte, 1/2/4-bit grey scales to 0–255, 1/2/4-bit palette indexes);
 * filters 0–4. Alpha (an alpha channel or tRNS) is flattened on white, as sips and slim's ffmpeg
 * filter do. Adam7-interlaced files are refused, not decoded.
 */
'use strict';

const zlib = require('zlib');

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const DEPTHS = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
// The inflated and the unfiltered rows cost up to 8 B a pixel each, the RGB copy 3 B: a 40 MP RGBA16 peaks near 800 MB.
const MAX_PIXELS = 40e6;

// header(buf) → { w, h, depth, type, interlace } from the IHDR right after the signature, or null.
function header(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 33 || !buf.subarray(0, 8).equals(SIG) || buf.toString('latin1', 12, 16) !== 'IHDR') return null;
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  return w > 0 && h > 0 ? { w, h, depth: buf[24], type: buf[25], interlace: buf[28] } : null;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

// Reverses the per-row filters of `raw` (h rows of 1 filter byte + stride bytes) → the rows without filter bytes, or null on an unknown filter.
function unfilter(raw, h, stride, bpp) {
  const out = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const row = y * stride;
    const up = row - stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[row + x - bpp] : 0;
      const b = y > 0 ? out[up + x] : 0;
      const c = x >= bpp && y > 0 ? out[up + x - bpp] : 0;
      const v = raw[src + x];
      let r;
      if (f === 0) r = v;
      else if (f === 1) r = v + a;
      else if (f === 2) r = v + b;
      else if (f === 3) r = v + ((a + b) >> 1);
      else if (f === 4) r = v + paeth(a, b, c);
      else return null;
      out[row + x] = r & 0xff;
    }
  }
  return out;
}

const onWhite = (c, a) => ((c * a + 255 * (255 - a) + 127) / 255) | 0;

/**
 * decode(buf) → { w, h, rgb } (rgb: Buffer of w*h*3, row-major, alpha flattened on white), or
 * { refused } with one of: 'png-invalid' (not a PNG, a broken chunk, an unknown colour type, depth,
 * filter or compression), 'png-interlaced' (Adam7), 'png-too-large' (over 40 MP). Never throws.
 */
function decode(buf) {
  const hd = header(buf);
  if (!hd) return { refused: 'png-invalid' };
  const { w, h, depth, type } = hd;
  if (!(DEPTHS[type] || []).includes(depth) || buf[26] !== 0 || buf[27] !== 0) return { refused: 'png-invalid' };
  if (hd.interlace !== 0) return { refused: 'png-interlaced' };
  if (w * h > MAX_PIXELS) return { refused: 'png-too-large' };
  let plte = null;
  let trns = null;
  const idat = [];
  for (let off = 8; off + 8 <= buf.length;) {
    const len = buf.readUInt32BE(off);
    const kind = buf.toString('latin1', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (data.length !== len) return { refused: 'png-invalid' };
    if (kind === 'PLTE') plte = data;
    else if (kind === 'tRNS') trns = data;
    else if (kind === 'IDAT') idat.push(data);
    else if (kind === 'IEND') break;
    off += 12 + len;
  }
  if (!idat.length || (type === 3 && !plte)) return { refused: 'png-invalid' };
  const ch = CHANNELS[type];
  const stride = Math.ceil((w * ch * depth) / 8);
  const bpp = Math.max(1, (ch * depth) >> 3);
  let raw;
  try { raw = zlib.inflateSync(Buffer.concat(idat), { maxOutputLength: h * (stride + 1) }); } catch (_) { return { refused: 'png-invalid' }; }
  if (raw.length < h * (stride + 1)) return { refused: 'png-invalid' };
  const px = unfilter(raw, h, stride, bpp);
  if (!px) return { refused: 'png-invalid' };

  const max = (1 << depth) - 1;
  // Sample i of row `row`: the raw value at its bit depth (16-bit: the full 16-bit value).
  const sample = (row, i) => {
    if (depth === 8) return px[row + i];
    if (depth === 16) return px.readUInt16BE(row + i * 2);
    const bit = i * depth;
    return (px[row + (bit >> 3)] >> (8 - depth - (bit & 7))) & max;
  };
  const to8 = (v) => (depth === 16 ? v >> 8 : depth === 8 ? v : ((v * 255) / max) | 0);
  const key = (i) => (trns && trns.length >= 2 * (i + 1) ? trns.readUInt16BE(2 * i) : -1);
  const greyKey = type === 0 ? key(0) : -1;
  const rgbKey = type === 2 ? [key(0), key(1), key(2)] : null;

  const rgb = Buffer.alloc(w * h * 3);
  let o = 0;
  for (let y = 0; y < h; y++) {
    const row = y * stride;
    for (let x = 0; x < w; x++) {
      let r;
      let g;
      let b;
      let a = 255;
      if (type === 0) {
        const v = sample(row, x);
        r = g = b = to8(v);
        if (v === greyKey) a = 0;
      } else if (type === 2) {
        const s0 = sample(row, x * 3);
        const s1 = sample(row, x * 3 + 1);
        const s2 = sample(row, x * 3 + 2);
        r = to8(s0); g = to8(s1); b = to8(s2);
        if (rgbKey && s0 === rgbKey[0] && s1 === rgbKey[1] && s2 === rgbKey[2]) a = 0;
      } else if (type === 3) {
        const i = sample(row, x);
        if (i * 3 + 2 >= plte.length) return { refused: 'png-invalid' };
        r = plte[i * 3]; g = plte[i * 3 + 1]; b = plte[i * 3 + 2];
        if (trns && i < trns.length) a = trns[i];
      } else if (type === 4) {
        r = g = b = to8(sample(row, x * 2));
        a = to8(sample(row, x * 2 + 1));
      } else {
        r = to8(sample(row, x * 4)); g = to8(sample(row, x * 4 + 1)); b = to8(sample(row, x * 4 + 2));
        a = to8(sample(row, x * 4 + 3));
      }
      if (a !== 255) { r = onWhite(r, a); g = onWhite(g, a); b = onWhite(b, a); }
      rgb[o++] = r; rgb[o++] = g; rgb[o++] = b;
    }
  }
  return { w, h, rgb };
}

module.exports = { decode, header };
