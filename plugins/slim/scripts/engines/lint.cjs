/*
 * engines/lint.cjs — linter output grouped by rule, severity first.
 *
 * Reads ESLint stylish and unix, stylelint, theme-check text, tsc (plain and --pretty) and
 * `prettier --check` lists into { file, line, col, level, rule, message } records; groups them by
 * level, rule and message template (quoted names, numbers and paths slotted, as log.cjs normalises a
 * line); prints per group its count, template and its first locations verbatim, then how many more
 * and in which files. The tool's own summary lines close the output. Pure: no I/O.
 */
'use strict';

const { utf8, commas } = require('./util.cjs');

const MARK = '<<slim-lint>>';
const SCAN = 65536;
const MIN_LINES = 30;
// Locations kept per group, one fit stage each; 0 = counts only.
const STAGES = [[5, 'lint'], [3, 'locs-3'], [1, 'locs-1'], [0, 'counts']];
const NOTES_MAX = 10;
const NOTE_CHARS = 300;
// Longer lines are never parsed: no linter writes one, and the regexes stay linear.
const LINE_MAX = 2000;
const FILES_MAX = 8;

const LEVEL = {
  error: 'E', fatal: 'E', '✖': 'E', '×': 'E',
  warning: 'W', warn: 'W', '⚠': 'W',
  info: 'N', note: 'N', suggestion: 'N', style: 'N', message: 'N', 'ℹ': 'N',
};
const RANK = { E: 0, W: 1, N: 2 };
const levelOf = (s) => LEVEL[String(s).toLowerCase()] || null;

const STYLISH = /^\s+(\d+):(\d+)\s+(error|warning|warn|info|✖|×|⚠|ℹ)\s+(\S.*)$/i;
const NESTED = /^\s+(error|warning|suggestion|info|style):\s+(\S.*)$/i;
const AT_LINE = /\s+at line (\d+)$/;
const TSC = /^(\S.*?)\((\d+),(\d+)\): (error|warning|message) (TS\d+): (.*)$/;
const TSC_PRETTY = /^(\S.*?):(\d+):(\d+) - (error|warning|message) (TS\d+): (.*)$/;
const BRACKET = /^\[(error|warning|suggestion|info|style)\]:?\s+(\S+?):(\d+)(?::(\d+))?:?\s+(.*)$/i;
const UNIX = /^(\S+?):(\d+):(?:(\d+):)?\s?(.*)$/;
const UNIX_LEAD = /^(error|warning|warn|info|note|suggestion|style):\s*(.*)$/i;
const ESLINT_TAIL = /\s*\[(Error|Warning|Info)\/([^\]]+)\]$/;
const LEVEL_TAIL = /\s*\[(error|warning|warn|info)\]$/i;
const PAREN_RULE = /\s*\(([@\w][\w@/.-]*)\)$/;
const PRETTIER = /^\[warn\]\s+(\S+)$/;
const RULE_LEAD = /^([A-Z][A-Za-z]+):\s+(.*)$/;
const RULE_WORD = /^[@\w][\w@/.:-]*$/;
const SUMMARY = /^\s*(?:[✖×⚠]\s*)?\d+ problems?\b|^\s*Found \d+ errors?\b|\b\d+ (?:offen[cs]es?|errors?|warnings?|problems?)\b.*\b(?:detected|found|in \d+ files?|fixable)\b|^\[warn\] Code style issues|\bfiles? inspected\b|^All matched files use Prettier/i;
const EXCERPT = /^\s*(?:>\s*)?\d+\s*[|│]|^\s*[|│]?\s*[~^]+\s*$|^Errors\s+Files$|^\s+\d+\s+\S+:\d+$/;
const PRETTY_CODE = /^\s*\d+\s/;

const tscRecord = (m, loc) => ({ file: m[1], line: m[2], col: m[3], loc, level: levelOf(m[4]), rule: m[5], message: m[6].trim(), fmt: 'tsc' });

// The message without its rule: a CamelCase `Rule: ` lead (theme-check) → { rule, message }.
function ruleLead(message) {
  const m = RULE_LEAD.exec(message);
  return m ? { rule: m[1], message: m[2] } : { rule: null, message };
}

// One `file:line[:col]: …` line → record fields, or null when no level is named (grep output is not lint).
function unixRecord(m) {
  let msg = m[4].trim();
  let level = null;
  let rule = null;
  let t = ESLINT_TAIL.exec(msg);
  if (t) { level = levelOf(t[1]); rule = t[2]; msg = msg.slice(0, t.index); }
  if (!level && (t = LEVEL_TAIL.exec(msg))) { level = levelOf(t[1]); msg = msg.slice(0, t.index); }
  if (!level && (t = UNIX_LEAD.exec(msg))) { level = levelOf(t[1]); ({ rule, message: msg } = ruleLead(t[2])); }
  if (!level) return null;
  if (!rule && (t = PAREN_RULE.exec(msg))) { rule = t[1]; msg = msg.slice(0, t.index); }
  return { file: m[1], line: m[2], col: m[3] || null, loc: `${m[1]}:${m[2]}${m[3] ? `:${m[3]}` : ''}`, level, rule, message: msg.trim(), fmt: 'unix' };
}

/**
 * Lines → { records, kinds, summary, formats }. kinds[i] is one of record | header | summary |
 * excerpt | blank | other; a stylish or nested record takes its file from the header line above it.
 */
function parse(lines) {
  const records = [];
  const kinds = new Array(lines.length);
  const summary = [];
  const formats = new Set();
  let header = -1;
  let file = null;
  let prev = 'blank';
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i].replace(/\r$/, '');
    let kind = 'other';
    let r = null;
    let m;
    if (!s.trim()) kind = 'blank';
    else if (s.length > LINE_MAX) kind = 'long';
    else if ((m = TSC.exec(s))) r = tscRecord(m, `${m[1]}(${m[2]},${m[3]})`);
    else if ((m = TSC_PRETTY.exec(s))) r = tscRecord(m, `${m[1]}:${m[2]}:${m[3]}`);
    else if ((m = BRACKET.exec(s))) {
      const { rule, message } = ruleLead(m[5].trim());
      r = { file: m[2], line: m[3], col: m[4] || null, loc: `${m[2]}:${m[3]}${m[4] ? `:${m[4]}` : ''}`, level: levelOf(m[1]), rule, message, fmt: 'theme-check' };
    } else if ((m = PRETTIER.exec(s))) {
      r = { file: m[1], line: null, col: null, loc: m[1], level: 'W', rule: 'prettier', message: 'not formatted', fmt: 'prettier' };
    } else if (SUMMARY.test(s)) kind = 'summary';
    else if (file !== null && (m = STYLISH.exec(s))) {
      const parts = m[4].trimEnd().split(/\s{2,}/);
      const rule = parts.length > 1 && RULE_WORD.test(parts[parts.length - 1]) ? parts.pop() : null;
      r = { file, line: m[1], col: m[2], loc: `${file}:${m[1]}:${m[2]}`, level: levelOf(m[3]), rule, message: parts.join('  ').trim(), fmt: 'stylish' };
    } else if (file !== null && (m = NESTED.exec(s))) {
      const body = m[2].trimEnd();
      const at = AT_LINE.exec(body);
      const { rule, message } = ruleLead(at ? body.slice(0, at.index) : body);
      r = { file, line: at ? at[1] : null, col: null, loc: at ? `${file}:${at[1]}` : file, level: levelOf(m[1]), rule, message, fmt: 'theme-check' };
    } else if ((m = UNIX.exec(s))) r = unixRecord(m);
    if (!r && kind === 'other' && (EXCERPT.test(s) || ((prev === 'record' || prev === 'excerpt') && PRETTY_CODE.test(s)))) kind = 'excerpt';
    if (r) {
      kind = 'record';
      records.push(r);
      formats.add(r.fmt);
      if (header >= 0 && (r.fmt === 'stylish' || r.fmt === 'theme-check') && r.file === file) { kinds[header] = 'header'; header = -1; }
    } else if (kind === 'long') kind = 'other';
    else if (kind === 'other' && !/^\s/.test(s)) {
      header = i;
      file = s.trim();
    }
    if (kind === 'summary') summary.push(s);
    kinds[i] = kind;
    if (kind !== 'blank') prev = kind;
  }
  return { records, kinds, summary, formats };
}

/** detectLint(text) → { isLint, confidence }: ≥ 30 non-blank lines, ≥ 70 % of them lint grammar, ≥ 25 % problems. */
function detectLint(text) {
  const lines = String(text).slice(0, SCAN).split('\n');
  const p = parse(lines);
  let nonBlank = 0;
  let matched = 0;
  for (const k of p.kinds) {
    if (k === 'blank') continue;
    nonBlank++;
    if (k !== 'other') matched++;
  }
  const isLint = nonBlank >= MIN_LINES && matched / nonBlank >= 0.7 && p.records.length / nonBlank >= 0.25;
  return { isLint, confidence: isLint ? (p.summary.length ? 0.9 : 0.8) : 0 };
}

// A message with what varies between its instances slotted, so one rule's messages share a line.
const template = (m) => m
  .replace(/'[^']*'/g, "'…'").replace(/"[^"]*"/g, '"…"').replace(/`[^`]*`/g, '`…`').replace(/‘[^’]*’/g, '‘…’')
  .replace(/\d+/g, 'N').replace(/\/[\w/]+\//g, '/PATH/');

function groupsOf(records) {
  const by = new Map();
  for (const r of records) {
    const tpl = template(r.message);
    const key = `${r.level}\u0000${r.rule || ''}\u0000${tpl}`;
    let g = by.get(key);
    if (!g) by.set(key, (g = { level: r.level, rule: r.rule, template: tpl, items: [], messages: new Set() }));
    g.items.push(r);
    g.messages.add(r.message);
  }
  return [...by.values()].sort((a, b) => RANK[a.level] - RANK[b.level] || b.items.length - a.items.length
    || String(a.rule || '').localeCompare(String(b.rule || '')) || a.template.localeCompare(b.template));
}

// `file ×n` for the given records, most first, at most FILES_MAX then `+N more`.
function fileCounts(items) {
  const n = new Map();
  for (const r of items) n.set(r.file, (n.get(r.file) || 0) + 1);
  const list = [...n.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const shown = list.slice(0, FILES_MAX).map(([f, c]) => `${f} ×${c}`);
  if (list.length > FILES_MAX) shown.push(`+${list.length - FILES_MAX} more`);
  return { files: list.length, text: shown.join(', ') };
}

function render(p, groups, notes, k) {
  const n = { E: 0, W: 0, N: 0 };
  for (const r of p.records) n[r.level]++;
  const files = new Set(p.records.map((r) => r.file)).size;
  const rules = new Set(p.records.filter((r) => r.rule).map((r) => r.rule)).size;
  const shown = groups.reduce((s, g) => s + Math.min(k, g.items.length), 0);
  const out = [`${MARK} ${[...p.formats].sort().join('+')} · ${commas(p.records.length)} problems: ${commas(n.E)} errors, ${commas(n.W)} warnings, ${commas(n.N)} notes · ${commas(files)} files · ${commas(rules)} rules · ${commas(shown)} locations shown, ${k ? `first ${k} per group` : 'counts only'}`];
  for (const g of groups) {
    const one = g.messages.size === 1;
    out.push('', `${g.rule || '(no rule)'} (${g.level} ${commas(g.items.length)}) — ${one ? g.items[0].message : g.template}`);
    for (const r of g.items.slice(0, k)) out.push(`  ${r.loc}${one ? '' : `  ${r.message}`}`);
    const rest = g.items.slice(k);
    if (rest.length) {
      const fc = fileCounts(rest);
      out.push(`  … ${k ? '+' : ''}${commas(rest.length)} in ${commas(fc.files)} file${fc.files === 1 ? '' : 's'} (${fc.text})`);
    }
  }
  if (notes.lines.length) {
    out.push('', `other output (${commas(notes.total)} line${notes.total === 1 ? '' : 's'}${notes.total > notes.lines.length ? `, ${notes.lines.length} shown` : ''}):`, ...notes.lines);
  }
  out.push('', ...p.summary, `rules: ${commas(rules)} · files: ${commas(files)}`,
    'full list: Read the original windowed, or rerun the linter on one file');
  return out.join('\n');
}

function run(text, opts, ctx) {
  const late = () => ctx && ctx.deadline != null && Date.now() > ctx.deadline;
  if (late()) return { decision: 'passthrough', reason: 'budget-exceeded', text };
  if (!detectLint(text).isLint) return { decision: 'passthrough', reason: 'non-lint', text };
  const lines = text.split('\n');
  const p = parse(lines);
  if (late()) return { decision: 'passthrough', reason: 'budget-exceeded', text };
  const groups = groupsOf(p.records);
  const seen = new Set();
  const others = [];
  p.kinds.forEach((k, i) => { if (k === 'other') others.push(lines[i].replace(/\r$/, '')); });
  const clip = (l) => (l.length > NOTE_CHARS ? `${l.slice(0, NOTE_CHARS)} … [+${commas(l.length - NOTE_CHARS)} chars]` : l);
  for (const l of others) if (seen.size < NOTES_MAX) seen.add(clip(l));
  const notes = { total: others.length, lines: [...seen] };
  const target = opts && opts.targetBytes;
  const stages = [];
  let out = null;
  for (const [k, stage] of STAGES) {
    out = render(p, groups, notes, k);
    stages.push(stage);
    if (!target || utf8(out) <= target) break;
  }
  if (late()) return { decision: 'passthrough', reason: 'budget-exceeded', text };
  if (utf8(out) >= utf8(text)) return { decision: 'passthrough', reason: 'no-gain', text };
  return { decision: 'compressed', text: out, stages };
}

module.exports = { id: 'lint', run, detectLint, parse, template, MARK };
