/*
 * engines/text-window.cjs — the plain-text window: head + tail whole lines around one marker.
 *
 * The only thing slim ever does to code, diffs, test output or prose: it never rewrites a line, it
 * hides the middle. The head takes whole lines up to a third of the budget, the tail fills the rest
 * (test summaries live at the end), and the marker in between counts what was hidden:
 *   [slim: <hidden> of <total> lines hidden (<hiddenBytes> B)]
 * Fewer than three lines, a first/last line that alone overflows its share, or whole lines that fill
 * less than half the budget fall back to a character window with `[slim: <hiddenBytes> B hidden]`.
 * A diff (sniff's `diff` guard) is first cut inside its overlong body lines — a -/+ pair to a window
 * around the fragment that changed, inline `[slim: <bytes> B hidden]` — then loses whole runs of
 * unchanged context (one `lines hidden` marker per run) before the head/tail window above applies.
 * Pure: no I/O.
 */
'use strict';

const { utf8, commas } = require('./util.cjs');
const { guard } = require('./sniff.cjs');

const DEFAULT_BUDGET = 12288;
const MARKER_RESERVE = 96;
const LINE_CAP = 1024;
const AROUND = 160;

// The longest prefix (or suffix) of `s` that fits `n` UTF-8 bytes, never splitting a surrogate pair.
function fitBytes(s, n, fromEnd) {
  if (n <= 0) return '';
  let len = Math.min(s.length, n);
  let cut = fromEnd ? s.slice(s.length - len) : s.slice(0, len);
  while (len > 0 && utf8(cut) > n) {
    len = Math.floor(len * 0.9);
    cut = fromEnd ? s.slice(s.length - len) : s.slice(0, len);
  }
  if (!fromEnd && /[\ud800-\udbff]$/.test(cut)) cut = cut.slice(0, -1);
  if (fromEnd && /^[\udc00-\udfff]/.test(cut)) cut = cut.slice(1);
  return cut;
}

function charWindow(text, budget) {
  const head = fitBytes(text, Math.floor(budget / 3), false);
  const tail = fitBytes(text, budget - utf8(head) - MARKER_RESERVE, true);
  const hiddenBytes = utf8(text) - utf8(head) - utf8(tail);
  const lines = text.split('\n').length;
  return {
    text: `${head}\n[slim: ${commas(hiddenBytes)} B hidden]\n${tail}`,
    window: { lines_total: lines, lines_hidden: 0, bytes_hidden: hiddenBytes },
  };
}

const cutMark = (n) => `[slim: ${commas(n)} B hidden]`;

// `s` cut to its first and last `keep` bytes around an inline marker; `cut.bytes` counts what it hid.
function squeeze(s, keep, cut) {
  if (utf8(s) <= 2 * keep + 32) return s;
  const head = fitBytes(s, keep, false);
  const tail = fitBytes(s.slice(head.length), keep, true);
  const n = utf8(s) - utf8(head) - utf8(tail);
  cut.bytes += n;
  return `${head}${cutMark(n)}${tail}`;
}

// A removed/added pair cut to AROUND bytes of their common prefix and suffix around what changed.
// [p, q]: the lengths of the common prefix and suffix of `a` and `b`, never splitting a surrogate pair.
function common(a, b) {
  const n = Math.min(a.length, b.length);
  let p = 0;
  while (p < n && a[p] === b[p]) p++;
  if (p > 0 && /[\ud800-\udbff]/.test(a[p - 1])) p--;
  let q = 0;
  while (q < n - p && a[a.length - 1 - q] === b[b.length - 1 - q]) q++;
  if (q > 0 && /[\udc00-\udfff]/.test(a[a.length - q])) q--;
  return [p, q];
}

function pairWindow(a, b, cut) {
  const [p, q] = common(a, b);
  const one = (s) => {
    const pre = s.slice(0, p);
    const suf = s.slice(s.length - q);
    const keepPre = fitBytes(pre, AROUND, true);
    const keepSuf = fitBytes(suf, AROUND, false);
    const lead = utf8(pre) - utf8(keepPre);
    const trail = utf8(suf) - utf8(keepSuf);
    cut.bytes += lead + trail;
    return `${lead ? cutMark(lead) : ''}${keepPre}${squeeze(s.slice(p, s.length - q), LINE_CAP / 2, cut)}${keepSuf}${trail ? cutMark(trail) : ''}`;
  };
  return [one(a), one(b)];
}

// A diff over budget: overlong body lines cut in place, then context runs hidden largest first.
function diffWindow(text, budget) {
  const lines = text.split('\n');
  const kind = [];
  let inHunk = false;
  for (const l of lines) {
    if (l.startsWith('diff ')) inHunk = false;
    if (l.startsWith('@@')) { inHunk = true; kind.push('h'); continue; }
    kind.push(!inHunk ? 'h' : l[0] === '-' || l[0] === '+' ? l[0] : l[0] === ' ' || l === '' ? ' ' : 'h');
  }
  const cut = { bytes: 0 };
  const out = lines.slice();
  const paired = new Set();
  for (let i = 0; i < out.length; i++) {
    if (kind[i] !== '-') continue;
    let j = i;
    while (j < out.length && kind[j] === '-') j++;
    let k = j;
    while (k < out.length && kind[k] === '+') k++;
    // An overlong line pairs with the line across the block that shares the most prefix + suffix with it.
    const cands = [];
    for (let x = i; x < j; x++) {
      for (let y = j; y < k; y++) {
        if (utf8(out[x]) <= LINE_CAP && utf8(out[y]) <= LINE_CAP) continue;
        const [p, q] = common(out[x].slice(1), out[y].slice(1));
        if (p + q > 0) cands.push({ x, y, score: p + q });
      }
    }
    cands.sort((u, v) => v.score - u.score);
    for (const { x, y } of cands) {
      if (paired.has(x) || paired.has(y)) continue;
      const [wa, wb] = pairWindow(out[x].slice(1), out[y].slice(1), cut);
      out[x] = `-${wa}`;
      out[y] = `+${wb}`;
      paired.add(x).add(y);
    }
    i = k - 1;
  }
  for (let i = 0; i < out.length; i++) {
    if (kind[i] !== 'h' && !paired.has(i) && utf8(out[i]) > LINE_CAP) out[i] = out[i][0] + squeeze(out[i].slice(1), LINE_CAP / 2, cut);
  }
  const size = (arr) => utf8(arr.join('\n'));
  let total = size(out);
  const runs = [];
  for (let i = 0; i < out.length; i++) {
    if (kind[i] !== ' ') continue;
    let j = i;
    while (j < out.length && kind[j] === ' ') j++;
    runs.push({ i, j, bytes: size(out.slice(i, j)) + 1 });
    i = j;
  }
  runs.sort((x, y) => y.bytes - x.bytes);
  const hide = [];
  let hiddenLines = 0;
  let hiddenBytes = 0;
  for (const r of runs) {
    if (total <= budget) break;
    const marker = `[slim: ${commas(r.j - r.i)} of ${commas(lines.length)} lines hidden (${commas(r.bytes)} B)]`;
    if (r.bytes <= utf8(marker) + 1) continue;
    hide.push({ ...r, marker });
    total += utf8(marker) + 1 - r.bytes;
    hiddenLines += r.j - r.i;
    hiddenBytes += r.bytes;
  }
  hide.sort((x, y) => y.i - x.i);
  for (const r of hide) out.splice(r.i, r.j - r.i, r.marker);
  const reduced = out.join('\n');
  const rest = utf8(reduced) > budget ? windowText(reduced, budget, true) : null;
  return {
    text: rest ? rest.text : reduced,
    window: {
      lines_total: lines.length,
      lines_hidden: hiddenLines + (rest ? rest.window.lines_hidden : 0),
      bytes_hidden: cut.bytes + hiddenBytes + (rest ? rest.window.bytes_hidden : 0),
    },
  };
}

// → { text, window:{lines_total, lines_hidden, bytes_hidden} }, or null when `text` already fits.
function windowText(text, budget = DEFAULT_BUDGET, plain = false) {
  if (utf8(text) <= budget) return null;
  if (!plain && guard(text) === 'diff') return diffWindow(text, budget);
  const lines = text.split('\n');
  if (lines.length < 3) return charWindow(text, budget);
  const headBudget = Math.floor(budget / 3);
  let headBytes = 0;
  let h = 0;
  while (h < lines.length && headBytes + utf8(lines[h]) + 1 <= headBudget) headBytes += utf8(lines[h++]) + 1;
  const tailBudget = budget - headBytes - MARKER_RESERVE;
  let tailBytes = 0;
  let t = lines.length;
  while (t - 1 > h && tailBytes + utf8(lines[t - 1]) + 1 <= tailBudget) tailBytes += utf8(lines[--t]) + 1;
  if (h === 0 || t === lines.length || headBytes + tailBytes < budget / 2) return charWindow(text, budget);
  const hidden = lines.slice(h, t);
  const hiddenBytes = utf8(hidden.join('\n')) + 1;
  const marker = `[slim: ${commas(hidden.length)} of ${commas(lines.length)} lines hidden (${commas(hiddenBytes)} B)]`;
  return {
    text: `${lines.slice(0, h).join('\n')}\n${marker}\n${lines.slice(t).join('\n')}`,
    window: { lines_total: lines.length, lines_hidden: hidden.length, bytes_hidden: hiddenBytes },
  };
}

// The engine entry: text at or under plainBytes is never touched.
function run(text, opts) {
  if (utf8(text) <= opts.plainBytes) return { decision: 'passthrough', reason: 'plain-gate', text };
  const w = windowText(text, opts.budgetBytes || DEFAULT_BUDGET);
  if (!w) return { decision: 'passthrough', reason: 'plain-gate', text };
  return { decision: 'compressed', text: w.text, stages: ['window'], window: w.window };
}

module.exports = { id: 'text', run, windowText, DEFAULT_BUDGET };
