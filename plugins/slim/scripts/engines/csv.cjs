/*
 * engines/csv.cjs — a delimited table (CSV, TSV, `;`-separated) as a profile the model can reason over.
 *
 * Output: a `<<slim-csv>>` header (rows × cols, delimiter, size), one line per column (type, min/max,
 * nulls, distinct, then the values of a category or three samples), a markdown table of the header,
 * the first 3 rows and 3 sampled rows with their data-row numbers (cells verbatim, long ones clipped),
 * and a footer naming the next call. Samples are picked by a PRNG seeded with the content hash: random
 * across the file, the same bytes on every run. With `targetBytes` the rows shrink first (3+3 → 3 →
 * 0), then the samples (3 → 1). Detection (`detect`) is the sniff rule. Pure: no I/O.
 */
'use strict';

const { sha, utf8, commas } = require('./util.cjs');
const { unwrapFence } = require('./json.cjs');

const MARK = '<<slim-csv>>';
const DELIMS = [',', '\t', ';'];
const SCAN = 65536;
const MIN_RECORDS = 20;
const CELL_MAX = 160;
const CELL_KEEP = 120;
const SAMPLE_MAX = 48;
const SAMPLE_KEEP = 40;
const CATEGORY_MAX = 50;
// [rows shown, samples per column], tried in order until the text fits targetBytes.
const PLANS = [[6, 3], [3, 3], [0, 3], [0, 1]];

const NULLISH = /^(?:|null|n\/a|nan)$/i;
const BOOL = /^(?:true|false|yes|no)$/i;
const INT = /^[+-]?(?:0|[1-9]\d*)$/;
const LEAD0 = /^[+-]?0\d/;
const DOT = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$|^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/;
const COMMA = /^[+-]?\d+,\d+$|^[+-]?\d{1,3}(?:\.\d{3})+(?:,\d+)?$/;
const DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
// A cell no header holds: a number, or a leading date or time (a log line's timestamp).
const HEADER_DATA = /^\s*(?:[+-]?[\d.,]+\s*$|\[?\d{4}[-/.]\d{1,2}[-/.]\d{1,2}\b|\[?\d{1,2}:\d{2}\b)/;
const fromDot = (v) => Number(v.replace(/,/g, ''));
const fromComma = (v) => Number(v.replace(/\./g, '').replace(',', '.'));

// RFC 4180 records: a field opening with `"` may hold the delimiter, `""` and line breaks.
function parse(text, d) {
  const rows = [];
  let row = [];
  const n = text.length;
  const end = (from) => { let e = from; while (e < n) { const c = text[e]; if (c === d || c === '\n' || c === '\r') break; e++; } return e; };
  let i = 0;
  while (i < n) {
    let v;
    if (text[i] === '"') {
      let j = i + 1;
      v = '';
      for (;;) {
        const k = text.indexOf('"', j);
        if (k === -1) { v += text.slice(j); j = n; break; }
        v += text.slice(j, k);
        if (text[k + 1] === '"') { v += '"'; j = k + 2; continue; }
        j = k + 1;
        break;
      }
      const e = end(j);
      v += text.slice(j, e);
      i = e;
    } else {
      const e = end(i);
      v = text.slice(i, e);
      i = e;
    }
    row.push(v);
    if (i >= n) break;
    if (text[i] === d) {
      i++;
      if (i >= n) row.push('');
      continue;
    }
    i += text[i] === '\r' && text[i + 1] === '\n' ? 2 : 1;
    rows.push(row);
    row = [];
  }
  if (row.length) rows.push(row);
  return rows.filter((r) => r.length > 1 || r[0].trim() !== '');
}

const firstLine = (s) => { const k = s.indexOf('\n'); return k === -1 ? s : s.slice(0, k); };
const countOf = (s, ch) => { let c = 0; for (let i = s.indexOf(ch); i !== -1; i = s.indexOf(ch, i + 1)) c++; return c; };

/**
 * The table shape of `text`, or null: `{ delim, width }` for the delimiter (`,`, tab, `;`) that splits
 * at least `min` records of the first 64 KB into the header's width (≥ 3) on ≥ 95 % of them, the header
 * holding no number and no leading date or time. The widest such delimiter wins.
 */
function detect(text, min = MIN_RECORDS) {
  const cut = text.length > SCAN;
  const head = cut ? text.slice(0, SCAN) : text;
  const line = firstLine(head);
  let best = null;
  for (const d of DELIMS) {
    if (countOf(line, d) < 2) continue;
    let recs = parse(head, d);
    if (cut) recs = recs.slice(0, -1);
    if (recs.length < min) continue;
    const width = recs[0].length;
    if (width < 3 || recs[0].some((c) => HEADER_DATA.test(c))) continue;
    if (recs.filter((r) => r.length === width).length < recs.length * 0.95) continue;
    if (!best || width > best.width) best = { delim: d, width };
  }
  return best;
}

// mulberry32: a small seeded PRNG, so a sample is random across the file and stable across runs.
function prng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// k distinct indices of [from, to), in draw order.
function draw(rand, k, from, to) {
  const got = new Set();
  const want = Math.min(k, to - from);
  while (got.size < want) got.add(from + Math.floor(rand() * (to - from)));
  return [...got];
}

const escapeCtl = (v) => v.replace(/\r?\n/g, '\\n').replace(/\t/g, '\\t');
const clipSample = (v) => { const s = escapeCtl(v); return s.length > SAMPLE_MAX ? `${s.slice(0, SAMPLE_KEEP)}…` : s; };
const cell = (v) => {
  const s = v.length > CELL_MAX ? `${v.slice(0, CELL_KEEP)}… [+${commas(v.length - CELL_KEEP)} chars]` : v;
  return s.replace(/\r?\n/g, '<br>').replace(/\|/g, '\\|');
};
const sizeOf = (b) => (b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(1)} MB`);

// The type of a column from its distinct non-null values: bool, integer, number, date, or null (text).
function typeOf(vals, delim) {
  const t = vals.map((v) => v.trim());
  if (t.every((v) => BOOL.test(v))) return { type: 'bool' };
  if (t.every((v) => INT.test(v) && !LEAD0.test(v))) return { type: 'integer', num: Number };
  const fmts = delim === ';' ? [[COMMA, fromComma], [DOT, fromDot]] : [[DOT, fromDot], [COMMA, fromComma]];
  for (const [re, num] of fmts) if (t.every((v) => re.test(v) && !LEAD0.test(v))) return { type: 'number', num };
  if (t.every((v) => DATE.test(v))) return { type: 'date', key: (v) => v.trim() };
  return null;
}

// One column → its profile: name, type, nulls, distinct, min/max (raw input strings), listed values or samples.
function profileColumn(name, rows, idx, delim, rand) {
  const counts = new Map();
  let nulls = 0;
  for (const r of rows) {
    const v = idx < r.length ? r[idx] : '';
    if (NULLISH.test(v.trim())) { nulls++; continue; }
    counts.set(v, (counts.get(v) || 0) + 1);
  }
  const vals = [...counts.keys()];
  const col = { name, nulls, distinct: vals.length, type: 'empty' };
  if (!vals.length) return col;
  const nonNull = rows.length - nulls;
  const t = typeOf(vals, delim);
  if (t && (t.num || t.key)) {
    let lo = vals[0];
    let hi = vals[0];
    const less = t.num ? (a, b) => t.num(a.trim()) < t.num(b.trim()) : (a, b) => t.key(a) < t.key(b);
    for (const v of vals) { if (less(v, lo)) lo = v; if (less(hi, v)) hi = v; }
    Object.assign(col, { type: t.type, min: lo, max: hi });
  } else if (t || (vals.length / nonNull < 0.5 && vals.length <= CATEGORY_MAX)) {
    col.type = t ? t.type : 'category';
    col.listed = vals.map((v, i) => [v, counts.get(v), i]).sort((a, b) => b[1] - a[1] || a[2] - b[2]);
    return col;
  } else {
    col.type = 'string';
  }
  col.samples = draw(rand, 3, 0, vals.length).map((i) => vals[i]);
  return col;
}

function columnLine(c, pad, samples) {
  const bits = [c.name.padEnd(pad), c.type];
  if (c.min !== undefined) bits.push(`min ${clipSample(c.min.trim())} max ${clipSample(c.max.trim())}`);
  bits.push(`nulls ${commas(c.nulls)}`);
  if (c.type !== 'empty') bits.push(`distinct ${commas(c.distinct)}`);
  if (c.listed) bits.push(c.listed.map(([v, n]) => `${clipSample(v)} ×${commas(n)}`).join(' · '));
  if (c.samples) bits.push(`e.g. ${c.samples.slice(0, samples).map(clipSample).join(' · ')}`);
  return bits.join('  ');
}

function tableLines(header, rows, picks) {
  const line = (cells) => `| ${cells.join(' | ')} |`;
  const width = header.length;
  const out = [line(['#', ...header.map(cell)]), line(Array(width + 1).fill('---'))];
  for (const i of picks) {
    const r = rows[i];
    const cells = r.length < width ? [...r, ...Array(width - r.length).fill('')] : r;
    out.push(line([String(i + 1), ...cells.map(cell)]));
  }
  return out;
}

function render(t, shown, samples) {
  const names = t.cols.map((c) => c.name);
  const pad = Math.min(24, Math.max(...names.map((n) => n.length)));
  const n = t.rows.length;
  const picks = shown >= 6 ? t.picks : t.picks.slice(0, Math.min(shown, 3));
  const head = [
    `${MARK} ${commas(n)} rows × ${commas(t.header.length)} cols · delimiter ${t.delim === '\t' ? 'tab' : t.delim} · ${sizeOf(t.bytes)}`,
    `${picks.length} rows shown`,
  ];
  if (t.ragged) head.push(`${commas(t.ragged)} rows of another width`);
  const out = [head.join(' · '), '', 'columns:', ...t.cols.map((c) => columnLine(c, pad, samples))];
  if (picks.length) {
    const label = picks.length > 3 ? 'rows 1–3 and 3 sampled' : `rows 1–${picks.length}`;
    out.push('', `${label} (# = data row):`, ...tableLines(t.header, t.rows, picks));
  }
  out.push('', 'next: a row or a filter → lookup({ path: <the full= file below>, question }) · a column or a row range → Read that file windowed (offset, limit)');
  return out.join('\n');
}

function run(text, opts, ctx) {
  const pass = (reason) => ({ decision: 'passthrough', reason, text });
  const late = () => ctx.deadline != null && Date.now() > ctx.deadline;
  if (late()) return pass('budget-exceeded');
  const fence = unwrapFence(text);
  const body = fence ? fence.body : text;
  const shape = detect(body, 2);
  if (!shape) return pass('non-csv');
  const recs = parse(body.charCodeAt(0) === 0xFEFF ? body.slice(1) : body, shape.delim);
  if (late()) return pass('budget-exceeded');
  const header = recs[0];
  const rows = recs.slice(1);
  const rand = prng(parseInt(sha(text, 8), 16));
  const cols = header.map((h, i) => profileColumn(h === '' ? `(col ${i + 1})` : h, rows, i, shape.delim, rand));
  const firsts = rows.map((_, i) => i).slice(0, 3);
  const picks = [...firsts, ...draw(rand, 3, 3, rows.length).sort((a, b) => a - b)];
  const ragged = rows.filter((r) => r.length !== header.length).length;
  if (late()) return pass('budget-exceeded');
  const t = { header, rows, cols, picks, ragged, delim: shape.delim, bytes: utf8(body) };
  const wrap = (s) => (fence ? [fence.preamble, s, fence.trailer].filter(Boolean).join('\n\n') : s);
  const target = opts && opts.targetBytes;
  const stages = ['profile'];
  const warnings = [];
  let out;
  let plan;
  for (plan of PLANS) {
    out = wrap(render(t, plan[0], plan[1]));
    if (!target || utf8(out) <= target) break;
  }
  const shownFull = Math.min(6, picks.length);
  const shown = Math.min(plan[0], picks.length);
  if (shown < shownFull) { stages.push('rows'); warnings.push(`rows: ${shownFull - shown} of ${shownFull} table rows dropped to meet targetBytes`); }
  if (plan[1] < 3) { stages.push('samples'); warnings.push('samples: 1 per column to meet targetBytes'); }
  if (target && utf8(out) > target) warnings.push(`targetBytes ${target} not met: ${utf8(out)} B`);
  if (utf8(out) >= utf8(text)) return pass('no-gain');
  return { decision: 'compressed', text: out, stages, warnings };
}

module.exports = { id: 'csv', run, detect, parse, MARK, DELIMS };
