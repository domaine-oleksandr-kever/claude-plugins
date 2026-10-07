/*
 * engines/text-window.cjs — the plain-text window: head + tail whole lines around one marker.
 *
 * The only thing slim ever does to code, diffs, test output or prose: it never rewrites a line, it
 * hides the middle. The head takes whole lines up to a third of the budget, the tail fills the rest
 * (test summaries live at the end), and the marker in between counts what was hidden:
 *   [slim: <hidden> of <total> lines hidden (<hiddenBytes> B)]
 * Fewer than three lines, or a first/last line that alone overflows its share, falls back to a
 * character window with `[slim: <hiddenBytes> B hidden]`. Pure: no I/O.
 */
'use strict';

const { utf8, commas } = require('./util.cjs');

const DEFAULT_BUDGET = 12288;
const MARKER_RESERVE = 96;

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

// → { text, window:{lines_total, lines_hidden, bytes_hidden} }, or null when `text` already fits.
function windowText(text, budget = DEFAULT_BUDGET) {
  if (utf8(text) <= budget) return null;
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
  if (h === 0 || t === lines.length) return charWindow(text, budget);
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
