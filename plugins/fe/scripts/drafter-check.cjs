#!/usr/bin/env node
// drafter-check.cjs — checks a drafter's file and its receipt in code, so the main session never
// reads the draft. Prints counts and `ok`/`fail` lines only, never the checked text.
//
//   drafter-check.cjs file stt <path>            steps-to-test.md: structure, attribution
//   drafter-check.cjs file pr <path> [--no-preview]  pr-body.md: core skeleton, theme preview table
//                                                (off with --no-preview when the notes.md beside it
//                                                records 'preview-decision: no preview'), None/N/A,
//                                                Summary, attribution
//   drafter-check.cjs file jira <path>           jira-comment.md: PR line, bulleted brief, no preview link, attribution
//   drafter-check.cjs receipt stt|pr|jira        the drafter's reply on stdin: one kind, no empty field
//
// First stdout line: result=ok|fail. Exit 0 ok, 1 fail, 2 usage.
'use strict';
const fs = require('fs');
const nodePath = require('path');

const USAGE = `usage: drafter-check.cjs file stt <path>
       drafter-check.cjs file pr <path> [--no-preview]   (--theme: accepted, no-op)
       drafter-check.cjs file jira <path>
       drafter-check.cjs receipt stt|pr|jira   (the drafter's reply on stdin)
The pr check requires the Theme preview table; --no-preview turns that off only when the notes.md
beside the checked file holds a 'preview-decision: no preview' line (the developer's recorded
answer) — else the table is still required. Prints no_preview=recorded|unrecorded|off.
Prints result=ok|fail, counts and one 'fail <check>' line per defect — never the checked text.
Exit 0 ok, 1 fail, 2 usage.`;

// ported from base hooks/mods/guards/attribution.ts — keep in sync
const ATTRIBUTION =
  /co-authored-by:[^<>]*(claude|anthropic|<[^<>]*@([A-Za-z0-9-]+\.)*anthropic\.com)|noreply@anthropic\.com|generated with \[?claude/i;

const attributionHits = (text) => text.split('\n').filter((l) => ATTRIBUTION.test(l)).length;

function report(lines, fails) {
  process.stdout.write([`result=${fails.length ? 'fail' : 'ok'}`, ...lines, ...fails.map((f) => `fail ${f}`)].join('\n') + '\n');
  return fails.length ? 1 : 0;
}

function readFile(path, fails) {
  let text = '';
  try { text = fs.readFileSync(path, 'utf8'); } catch (e) { fails.push('file missing'); return null; }
  if (!text.trim()) { fails.push('file empty'); return null; }
  return text;
}

/** Steps to Test: the structural rules of base references/steps-to-test/{templates,self-check}.md a script can see. */
function checkStt(path) {
  const fails = [];
  const text = readFile(path, fails);
  if (text === null) return report(['kind=stt'], fails);
  const lines = text.split('\n');
  const first = lines.find((l) => l.trim()) || '';
  // templates.md: both templates open with `1. **Theme:**`
  if (!/^1\. \*\*Theme:\*\*/.test(first)) fails.push('item 1 is not the **Theme:** line');
  // templates.md: the Bug template's items 2–4, the General template's Where / Edge cases
  const bug = /\*\*Why the bug happened:\*\*/.test(text);
  const need = bug
    ? [/^2\. \*\*Why the bug happened:\*\*/m, /^3\. \*\*What was changed to fix it:\*\*/m, /^4\. \*\*What to expect:\*\*/m]
    : [/^2\. \*\*Where:\*\*/m, /^\d+\. \*\*Edge cases:\*\*/m];
  const names = bug ? ['Why the bug happened', 'What was changed to fix it', 'What to expect'] : ['Where', 'Edge cases'];
  need.forEach((re, i) => { if (!re.test(text)) fails.push(`item missing: ${names[i]}`); });
  // self-check.md: one ordered list numbered through; no headings, tables or ✅ markers
  const nums = lines.map((l) => (/^(\d+)\. /.exec(l) || [])[1]).filter(Boolean).map(Number);
  // item-rules.md n+2: Context / out of scope is optional, and the last item when present
  const numbered = lines.filter((l) => /^\d+\. /.test(l));
  const ctx = numbered.findIndex((l) => /^\d+\. \*\*Context \/ out of scope:\*\*/.test(l));
  if (!bug && ctx >= 0 && ctx !== numbered.length - 1) fails.push('Context / out of scope is not the last item');
  if (nums.some((n, i) => n !== i + 1)) fails.push('items not numbered through from 1');
  if (lines.some((l) => /^#{1,6} /.test(l))) fails.push('heading in the field');
  if (lines.some((l) => /^\s*\|.*\|\s*$/.test(l))) fails.push('table in the field');
  if (text.includes('✅')) fails.push('✅ marker in the field');
  const hits = attributionHits(text);
  if (hits) fails.push('AI attribution');
  return report(['kind=stt', `template=${bug ? 'bug' : 'general'}`, `items=${nums.length}`, `attribution_hits=${hits}`], fails);
}

// fe create-pull-request reference/body-sections.md: the core skeleton, in order. The docs ask for a
// `## <Name>` heading line; a bold label at the start of a line is accepted too.
const CORE = [
  ['Summary', /^summary\b/i],
  ['Jira ticket', /^jira\b/i],
  ['To check', /^to check\b/i],
  ['Screenshots', /^screenshots?\b/i],
  ['Changes', /^changes\b/i],
];
const sectionLabel = (line) => {
  const m = /^(?:#{1,6}[ \t]+|\*\*)(.+)$/.exec(line.trim());
  return m ? m[1].replace(/\*\*/g, '').trim() : null;
};

function summarySentences(lines, from, to) {
  const body = lines.slice(from, to).map((l, i) => {
    let s = l.replace(/^\s*>\s?/, '');
    if (i === 0) s = s.replace(/^(?:#{1,6}[ \t]+|\*\*)?summary\b(?:\*\*)?[\s:—–-]*(?:\*\*)?\s*/i, '');
    return s.trim();
  }).filter(Boolean).join(' ');
  return body.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => /\w/.test(s));
}

/** `--no-preview` state: 'off' without the flag; 'recorded' when <dir of path>/notes.md holds a `preview-decision: no preview` line, else 'unrecorded'. */
function noPreviewState(path, flag) {
  if (!flag) return 'off';
  let notes = '';
  try { notes = fs.readFileSync(nodePath.join(nodePath.dirname(path), 'notes.md'), 'utf8'); } catch (e) { return 'unrecorded'; }
  return /preview-decision:\s*no preview/i.test(notes) ? 'recorded' : 'unrecorded';
}

/** PR body: core skeleton in order, the theme table unless `noPreview` is 'recorded', no None/N/A section, Summary sentence lengths, attribution. */
function checkPr(path, noPreview) {
  const fails = [];
  const text = readFile(path, fails);
  const np = `no_preview=${noPreview}`;
  if (text === null) return report(['kind=pr', np], fails);
  const lines = text.split('\n');
  const at = CORE.map(([, re]) => lines.findIndex((l) => { const s = sectionLabel(l); return s !== null && re.test(s); }));
  CORE.forEach(([name], i) => { if (at[i] < 0) fails.push(`section missing: ${name} (a \`## ${name}\` heading line)`); });
  const found = at.filter((i) => i >= 0);
  if (found.some((v, i) => i && v < found[i - 1])) fails.push('core sections out of order');
  if (noPreview !== 'recorded') {
    const row = lines.findIndex((l) => /^\s*\|\s*\*\*(Preview|Theme ID|Theme name)\*\*\s*\|/.test(l));
    if (row < 0) fails.push(noPreview === 'unrecorded'
      ? `theme preview table missing (--no-preview needs a 'preview-decision: no preview' line in ${nodePath.join(nodePath.dirname(path), 'notes.md')})`
      : "theme preview table missing (pass --no-preview only with the developer's explicit no-preview answer)");
    else if ((at[1] >= 0 && row < at[1]) || (at[2] >= 0 && row > at[2])) fails.push('theme preview table not between Jira ticket and To check');
  }
  if (lines.some((l) => /^\s*(?:[-*>]\s*)?[_*]*\(?(none|n\/a)\)?\.?[_*]*\s*$/i.test(l))) fails.push('None/N/A placeholder');
  let sentences = [];
  if (at[0] >= 0) {
    const next = at.filter((i) => i > at[0]);
    sentences = summarySentences(lines, at[0], next.length ? Math.min(...next) : lines.length);
    if (!sentences.length) fails.push('Summary empty');
  }
  const long = sentences.filter((s) => s.split(/\s+/).filter(Boolean).length >= 20).length;
  if (long) fails.push('Summary sentence of 20 words or more');
  const hits = attributionHits(text);
  if (hits) fails.push('AI attribution');
  return report(['kind=pr', np, `summary_sentences=${sentences.length}`, `long_sentences=${long}`, `attribution_hits=${hits}`], fails);
}

// fe create-pull-request Phase 2 step 2: the PR line, then an optional brief of at most 6 lines.
// A preview theme is deleted after merge, so its link, id or editor URL rots in the ticket.
const PR_LINE = /^PR: https:\/\/\S+\/pull\/\d+ — \S/;
const ROT = [
  ['preview theme link', /preview_theme_id=|shopifypreview\.com|\/themes\/\d+\/preview/i],
  ['editor URL', /\/themes\/\d+\/editor|\/admin\/themes\/\d+|admin\.shopify\.com\/store\/[^/\s]+\/themes\/\d+/i],
  ['theme id', /\btheme[ _-]?id\b|\btheme\s*#?\d{6,}|\b\d{11,14}\b/i],
];
const BRIEF_KEY = /^\s*(?:workspace|mode|answers|ticket|target|findings|related|screenshot_dir|previous|feedback|question|pr_url|pr_title|brief):\s|^\s*(?:branch|base)=/;

/** Jira PR-link comment: the PR line first, brief lines ≤ 6, no bare label, no None/N/A, nothing that rots, no brief text, attribution. */
function checkJira(path) {
  const fails = [];
  const text = readFile(path, fails);
  if (text === null) return report(['kind=jira'], fails);
  const lines = text.split('\n').filter((l) => l.trim());
  if (!PR_LINE.test(lines[0] || '')) fails.push("line 1 is not 'PR: <url> — <title>'");
  const brief = lines.slice(1);
  if (brief.length > 6) fails.push('brief longer than 6 lines');
  if (brief.some((l) => !/^\s*[-*]\s+\S/.test(l))) fails.push('brief line is not a bullet');
  if (lines.some((l) => /^#{1,6} /.test(l))) fails.push('heading in the comment');
  const label = (l) => /^\s*(?:[-*]\s+)?(?:\*\*[^*]+\*\*|[A-Z][\w /]*:)\s*(?:\*\*)?\s*:?\s*$/.test(l);
  const opensLabel = (l) => label(l) || /^\s*(?:(?:[-*]\s+)?\*\*[^*]+\*\*|[A-Z][\w /]*:)/.test(l);
  // a next line that opens no bold label is its content (`- Desktop: …` too)
  if (brief.some((l, i) => label(l) && (i + 1 >= brief.length || opensLabel(brief[i + 1])))) fails.push('label with no content');
  if (lines.some((l) => /^\s*(?:[-*>]\s*)?(?:(?:\*\*[^*]+\*\*|[A-Z][\w /]*:)\s*:?\s*)?[_*]*\(?(none|n\/a)\)?\.?[_*]*\s*$/i.test(l))) fails.push('None/N/A placeholder');
  for (const [name, re] of ROT) if (lines.some((l) => re.test(l))) fails.push(name);
  if (lines.some((l) => BRIEF_KEY.test(l))) fails.push('brief text in the comment');
  const hits = attributionHits(text);
  if (hits) fails.push('AI attribution');
  return report(['kind=jira', `brief_lines=${brief.length}`, `attribution_hits=${hits}`], fails);
}

// `[a, b, "c, d"]` → its entries, commas inside quotes kept
function splitOptions(v) {
  const m = /^\[(.*)\]$/.exec(v.trim());
  if (!m) return null;
  const out = []; let cur = ''; let q = null;
  for (const ch of m[1]) {
    if (q) { if (ch === q) q = null; cur += ch; continue; }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (ch === ',') { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur.trim());
  return out.filter((s) => s.replace(/^["']|["']$/g, '').trim());
}

// `- a: x` opens an item; indented `b: y` lines add to it; indented `- v` lines under an empty `b:`
// make it a block list
function items(lines, opener) {
  const list = [];
  let last = null;
  for (const l of lines) {
    const open = new RegExp(`^\\s*-\\s+${opener}:\\s*(.*)$`).exec(l);
    if (open) { list.push({ [opener]: open[1].trim() }); last = opener; continue; }
    const it = list[list.length - 1];
    const f = /^\s+([a-z_]+):\s*(.*)$/.exec(l);
    if (f && it && !(f[1] in it)) { it[f[1]] = f[2].trim(); last = f[1]; continue; }
    const entry = /^\s+-\s+(.*\S)\s*$/.exec(l);
    if (entry && it && last && (it[last] === '' || Array.isArray(it[last]))) it[last] = [...(it[last] || []), entry[1]];
  }
  return list;
}

// a `key:` value, inline or the lines under it up to the next top-level `key:` line
function field(lines, key) {
  const i = lines.findIndex((l) => new RegExp(`^${key}:`).test(l));
  if (i < 0) return null;
  let v = lines[i].slice(key.length + 1).trim();
  if (v === '|' || v === '>' || v === '') {
    const block = [];
    for (const l of lines.slice(i + 1)) { if (/^[a-z_]+:/.test(l)) break; if (l.trim()) block.push(l.trim()); }
    v = block.join(' ');
  }
  return v;
}

/** A drafter's reply: exactly one kind, every field the contract names non-empty. */
function checkReceipt(kind, text) {
  const fails = [];
  const lines = text.split('\n');
  const kinds = [];
  if (lines.some((l) => /^ESCALATE\s*$/.test(l))) kinds.push('escalate');
  if (lines.some((l) => /^LOOKUP\s*$/.test(l))) kinds.push('lookup');
  for (const k of ['answer', 'written', 'error']) if (lines.some((l) => new RegExp(`^${k}:`).test(l))) kinds.push(k);
  if (kinds.length !== 1) {
    fails.push(kinds.length ? `several kinds in one reply (${kinds.join(', ')})` : 'no kind (ESCALATE, LOOKUP, answer:, written:, error:)');
    return report([`kind=${kinds.join('+') || 'none'}`], fails);
  }
  const k = kinds[0];
  const out = [`kind=${k}`];
  if (k === 'escalate') {
    const list = items(lines, 'question');
    out.push(`items=${list.length}`);
    if (!list.length) fails.push('ESCALATE with no question');
    if (list.length > 4) fails.push('more than 4 questions');
    list.forEach((it, i) => {
      for (const f of ['question', 'context', 'options']) if (!it[f]) fails.push(`item ${i + 1} ${f} empty`);
      if (it.options) { const o = Array.isArray(it.options) ? it.options : splitOptions(it.options); if (!o || o.length < 2) fails.push(`item ${i + 1} options fewer than 2`); }
    });
  } else if (k === 'lookup') {
    if (kind !== 'stt') fails.push('LOOKUP is the stt drafter\'s only');
    const list = items(lines, 'store');
    out.push(`items=${list.length}`);
    if (!list.length) fails.push('LOOKUP with no item');
    if (list.length > 8) fails.push('more than 8 lookups');
    list.forEach((it, i) => { for (const f of ['store', 'need']) if (!it[f]) fails.push(`item ${i + 1} ${f} empty`); });
  } else if (k === 'written') {
    const p = field(lines, 'written') || '';
    const want = { stt: '/steps-to-test.md', pr: '/pr-body.md', jira: '/jira-comment.md' }[kind];
    if (!p.startsWith('/') || !p.endsWith(want)) fails.push(`written is not an absolute path ending in ${want}`);
    if (field(lines, 'unconfirmed') === null) fails.push('unconfirmed missing');
    if (!field(lines, 'report')) fails.push('report empty');
    if (kind === 'pr') {
      if (!field(lines, 'title')) fails.push('title empty');
      if (!field(lines, 'pr_summary')) fails.push('pr_summary empty');
      const shots = field(lines, 'screenshots');
      if (shots === null) fails.push('screenshots missing');
      else if (/^\[\s*\]$/.test(shots) && !field(lines, 'capture')) fails.push('capture empty with screenshots: []');
    }
  } else if (!field(lines, k)) {
    fails.push(`${k} empty`);
  }
  return report(out, fails);
}

function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) { process.stdout.write(USAGE + '\n'); return 0; }
  const [cmd, kind, path, ...rest] = argv;
  if (!['stt', 'pr', 'jira'].includes(kind)) { process.stderr.write(USAGE + '\n'); return 2; }
  if (cmd === 'file' && path) {
    const unknown = rest.filter((a) => !(kind === 'pr' && (a === '--theme' || a === '--no-preview')));
    if (unknown.length) { process.stderr.write(USAGE + '\n'); return 2; }
    if (kind === 'jira') return checkJira(path);
    return kind === 'stt' ? checkStt(path) : checkPr(path, noPreviewState(path, rest.includes('--no-preview')));
  }
  if (cmd === 'receipt' && path === undefined) {
    let text = '';
    try { text = fs.readFileSync(0, 'utf8'); } catch (e) { /* no stdin → empty reply */ }
    return checkReceipt(kind, text);
  }
  process.stderr.write(USAGE + '\n');
  return 2;
}

process.exitCode = main(process.argv.slice(2));
