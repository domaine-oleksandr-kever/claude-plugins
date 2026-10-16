/*
 * engines/codec/resize.cjs — area-average (box) downscale of 8-bit RGB, aspect kept, never upscaled.
 */
'use strict';

/**
 * resize({ w, h, rgb }, longEdge) → { w, h, rgb } with the long edge at most `longEdge` (sizes rounded
 * as engines/media.cjs fit() rounds them). Each output pixel is the rounded mean of the source pixels
 * whose integer-aligned box it covers. An image already within the edge comes back as given.
 */
function resize(img, longEdge) {
  const { w, h, rgb } = img;
  const long = Math.max(w, h);
  if (long <= longEdge) return img;
  const s = longEdge / long;
  const dw = Math.max(1, Math.round(w * s));
  const dh = Math.max(1, Math.round(h * s));
  const xs = Int32Array.from({ length: dw + 1 }, (_, i) => Math.floor((i * w) / dw));
  const out = Buffer.alloc(dw * dh * 3);
  const acc = new Uint32Array(dw * 3);
  for (let dy = 0; dy < dh; dy++) {
    const y0 = Math.floor((dy * h) / dh);
    const y1 = Math.floor(((dy + 1) * h) / dh);
    acc.fill(0);
    for (let y = y0; y < y1; y++) {
      const row = y * w * 3;
      for (let dx = 0; dx < dw; dx++) {
        let r = 0;
        let g = 0;
        let b = 0;
        for (let p = row + xs[dx] * 3, end = row + xs[dx + 1] * 3; p < end; p += 3) { r += rgb[p]; g += rgb[p + 1]; b += rgb[p + 2]; }
        acc[dx * 3] += r; acc[dx * 3 + 1] += g; acc[dx * 3 + 2] += b;
      }
    }
    const o = dy * dw * 3;
    for (let dx = 0; dx < dw; dx++) {
      const n = (xs[dx + 1] - xs[dx]) * (y1 - y0);
      for (let c = 0; c < 3; c++) out[o + dx * 3 + c] = Math.floor((acc[dx * 3 + c] + (n >> 1)) / n);
    }
  }
  return { w: dw, h: dh, rgb: out };
}

module.exports = { resize };
