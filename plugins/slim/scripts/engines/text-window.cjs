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
 * unchanged context (one `lines hidden` marker per run), then a ranked window: commits and subjects,
 * `diff` lines, other headers and commit text, then a head/tail of the hunks (one marker per hidden
 * stretch). A diff never takes the character window.
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

function pairWindow(a, b, cutA, cutB) {
  const [p, q] = common(a, b);
  const one = (s, cut) => {
    const pre = s.slice(0, p);
    const suf = s.slice(s.length - q);
    const keepPre = fitBytes(pre, AROUND, true);
    const keepSuf = fitBytes(suf, AROUND, false);
    const lead = utf8(pre) - utf8(keepPre);
    const trail = utf8(suf) - utf8(keepSuf);
    cut.bytes += lead + trail;
    return `${lead ? cutMark(lead) : ''}${keepPre}${squeeze(s.slice(p, s.length - q), LINE_CAP / 2, cut)}${keepSuf}${trail ? cutMark(trail) : ''}`;
  };
  return [one(a, cutA), one(b, cutB)];
}

// Window ranks, kept in this order when a diff is over budget: a commit line and its subject, a
// `diff` line, other file headers and commit text, `index`/`---`/`+++`, then the hunks themselves.
const RANK_COMMIT = 0;
const RANK_DIFF = 1;
const RANK_PROSE = 2;
const RANK_PATHS = 3;
const RANK_BODY = 4;
const PATHS = /^(?:index [0-9a-f]|--- |\+\+\+ )/;
const HUNK = /^(@{2,}) ((?:-\d+(?:,\d+)? )+)\+\d+(?:,(\d+))? \1/;

// Per line: kind ('h' header or prose, ' ' context, '-'/'+' changed, '\\' a no-newline note), the width
// of its body prefix, and its window rank. A line is hunk body only while its hunk's @@ counts are
// open, so a commit header or message after a file's last hunk is prose, not context.
function classify(lines) {
  const kind = [];
  const width = [];
  const rank = [];
  let open = null; // { n: parents, old: lines left per parent, add: new lines left }
  let subject = false;
  const push = (k, w, r) => { kind.push(k); width.push(w); rank.push(r); };
  for (const l of lines) {
    if (l.startsWith('@@')) {
      const m = HUNK.exec(l);
      const olds = m ? m[2].trim().split(' ').map((r) => (r.includes(',') ? Number(r.split(',')[1]) : 1)) : [];
      // An @@ line whose counts do not parse keeps the hunk open until the next diff or @@ line.
      open = m && olds.length === m[1].length - 1
        ? { n: olds.length, old: olds, add: m[3] === undefined ? 1 : Number(m[3]) }
        : { n: 1, old: [Infinity], add: Infinity };
      if (open.add <= 0 && open.old.every((x) => x <= 0)) open = null;
      push('h', 0, RANK_BODY);
      subject = false;
      continue;
    }
    if (l.startsWith('diff ')) open = null;
    if (l[0] === '\\') { push('\\', 0, RANK_BODY); continue; }
    const p = open && (l === '' ? ' '.repeat(open.n) : l.slice(0, open.n));
    if (p && p.length === open.n && /^[ +-]+$/.test(p)) {
      push(p.includes('-') ? '-' : p.includes('+') ? '+' : ' ', l === '' ? 0 : open.n, RANK_BODY);
      if (!p.includes('-')) open.add--;
      for (let i = 0; i < open.n; i++) if (p[i] !== '+') open.old[i]--;
      if (open.add <= 0 && open.old.every((x) => x <= 0)) open = null;
      continue;
    }
    if (open) { push('h', 0, RANK_BODY); continue; }
    const commit = /^commit [0-9a-f]{7,}/.test(l);
    const subj = subject && /^ {4}\S/.test(l);
    if (commit || l.startsWith('diff ') || subj) subject = commit;
    push('h', 0, commit || subj ? RANK_COMMIT : l.startsWith('diff ') ? RANK_DIFF : PATHS.test(l) ? RANK_PATHS : RANK_PROSE);
  }
  return { kind, width, rank };
}

// A diff over budget: overlong lines cut in place, then context runs hidden largest first, then the
// ranked window. Every marker counts original lines and bytes out of the original total.
function diffWindow(text, budget) {
  const lines = text.split('\n');
  const { kind, width, rank } = classify(lines);
  const out = lines.slice();
  const cuts = lines.map(() => ({ bytes: 0 }));
  const paired = new Set();
  for (let i = 0; i < out.length; i++) {
    if (kind[i] !== '-') continue;
    let j = i;
    while (j < out.length && (kind[j] === '-' || kind[j] === '\\')) j++;
    let k = j;
    while (k < out.length && (kind[k] === '+' || kind[k] === '\\')) k++;
    // An overlong line pairs with the line across the block that shares the most prefix + suffix with it.
    const cands = [];
    for (let x = i; x < j; x++) {
      for (let y = j; y < k; y++) {
        if (kind[x] !== '-' || kind[y] !== '+' || (utf8(out[x]) <= LINE_CAP && utf8(out[y]) <= LINE_CAP)) continue;
        const [p, q] = common(out[x].slice(width[x]), out[y].slice(width[y]));
        if (p + q > 0) cands.push({ x, y, score: p + q });
      }
    }
    cands.sort((u, v) => v.score - u.score);
    for (const { x, y } of cands) {
      if (paired.has(x) || paired.has(y)) continue;
      const [wa, wb] = pairWindow(out[x].slice(width[x]), out[y].slice(width[y]), cuts[x], cuts[y]);
      out[x] = out[x].slice(0, width[x]) + wa;
      out[y] = out[y].slice(0, width[y]) + wb;
      paired.add(x).add(y);
    }
    i = k - 1;
  }
  for (let i = 0; i < out.length; i++) {
    if (!paired.has(i) && utf8(out[i]) > LINE_CAP) {
      out[i] = out[i].slice(0, width[i]) + squeeze(out[i].slice(width[i]), LINE_CAP / 2, cuts[i]);
    }
  }
  const mark = (n, b) => `[slim: ${commas(n)} of ${commas(lines.length)} lines hidden (${commas(b)} B)]`;
  // parts: what is printed, with the original lines and bytes it stands for; `hid` marks a marker.
  let parts = out.map((t, i) => ({ text: t, lines: 1, bytes: utf8(lines[i]) + 1, cut: cuts[i].bytes, hid: false, rank: rank[i] }));
  const size = (arr) => arr.reduce((n, p) => n + utf8(p.text) + 1, 0) - 1;
  let total = size(parts);
  const runs = [];
  for (let i = 0; i < out.length; i++) {
    if (kind[i] !== ' ') continue;
    let j = i;
    while (j < out.length && kind[j] === ' ') j++;
    const span = parts.slice(i, j);
    runs.push({ i, j, now: size(span) + 1, bytes: span.reduce((n, p) => n + p.bytes, 0) });
    i = j;
  }
  runs.sort((x, y) => y.now - x.now);
  const hide = [];
  for (const r of runs) {
    if (total <= budget) break;
    const marker = mark(r.j - r.i, r.bytes);
    if (r.now <= utf8(marker) + 1) continue;
    hide.push({ ...r, marker });
    total += utf8(marker) + 1 - r.now;
  }
  hide.sort((x, y) => y.i - x.i);
  const merged = (span) => ({ text: mark(span.reduce((x, p) => x + p.lines, 0), span.reduce((x, p) => x + p.bytes, 0)),
    lines: span.reduce((x, p) => x + p.lines, 0), bytes: span.reduce((x, p) => x + p.bytes, 0), cut: 0, hid: true, rank: RANK_BODY });
  for (const r of hide) parts.splice(r.i, r.j - r.i, merged(parts.slice(r.i, r.j)));
  if (total > budget) parts = rankedWindow(parts, budget, mark, merged);
  const hidden = parts.filter((p) => p.hid);
  return {
    text: parts.map((p) => p.text).join('\n'),
    window: {
      lines_total: lines.length,
      lines_hidden: hidden.reduce((x, p) => x + p.lines, 0),
      bytes_hidden: parts.reduce((x, p) => x + (p.hid ? p.bytes : p.cut), 0),
    },
  };
}

// The ranked window of a diff, never over `budget` once it holds one marker: everything starts hidden,
// then whole parts are kept by rank, each rank in document order up to its first part that does not
// fit — ranks above the body up to three quarters of the budget, then the body's head up to a third
// of what is left and its tail the rest, then the ranks above the body again. Each hidden stretch
// between kept parts is one marker, unless it is no longer than its marker; adjacent markers merge.
function rankedWindow(parts, budget, mark, merged) {
  const n = parts.length;
  const pre = { size: [0], lines: [0], bytes: [0] };
  for (const p of parts) {
    pre.size.push(pre.size[pre.size.length - 1] + utf8(p.text) + 1);
    pre.lines.push(pre.lines[pre.lines.length - 1] + p.lines);
    pre.bytes.push(pre.bytes[pre.bytes.length - 1] + p.bytes);
  }
  const raw = (a, b) => pre.size[b] - pre.size[a];
  const marker = (a, b) => (b - a === 1 && parts[a].hid ? Infinity : utf8(mark(pre.lines[b] - pre.lines[a], pre.bytes[b] - pre.bytes[a])) + 1);
  const gap = (a, b) => (a >= b ? 0 : Math.min(raw(a, b), marker(a, b)));
  // Sizes count a newline after every line, so the limit is budget + 1.
  const kept = [];
  let total = gap(0, n);
  const keep = (k, limit) => {
    let lo = 0;
    let hi = kept.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (kept[m] < k) lo = m + 1; else hi = m; }
    if (kept[lo] === k) return true;
    const a = lo ? kept[lo - 1] + 1 : 0;
    const b = lo < kept.length ? kept[lo] : n;
    const d = gap(a, k) + raw(k, k + 1) + gap(k + 1, b) - gap(a, b);
    if (total + d > limit) return false;
    kept.splice(lo, 0, k);
    total += d;
    return true;
  };
  const byRank = Array.from({ length: RANK_BODY + 1 }, () => []);
  parts.forEach((p, i) => byRank[p.rank].push(i));
  const skeleton = (limit) => {
    for (let r = 0; r < RANK_BODY; r++) for (const i of byRank[r]) if (!keep(i, limit)) break;
  };
  skeleton(Math.floor(budget * 3 / 4) + 1);
  const headCap = total + Math.floor((budget + 1 - total) / 3);
  for (const i of byRank[RANK_BODY]) if (!keep(i, headCap)) break;
  for (const i of byRank[RANK_BODY].slice().reverse()) if (!keep(i, budget + 1)) break;
  skeleton(budget + 1);
  const res = [];
  const put = (p) => res.push(p.hid && res.length && res[res.length - 1].hid ? merged([res.pop(), p]) : p);
  let a = 0;
  for (const k of [...kept, n]) {
    if (k > a) (raw(a, k) <= marker(a, k) ? parts.slice(a, k) : [merged(parts.slice(a, k))]).forEach(put);
    if (k < n) put(parts[k]);
    a = k + 1;
  }
  return res;
}

// → { text, window:{lines_total, lines_hidden, bytes_hidden} }, or null when `text` already fits.
function windowText(text, budget = DEFAULT_BUDGET) {
  if (utf8(text) <= budget) return null;
  if (guard(text) === 'diff') return diffWindow(text, budget);
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

module.exports = { id: 'text', run, windowText, charWindow, DEFAULT_BUDGET };
