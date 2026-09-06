#!/usr/bin/env node
/*
 * md-to-adf.cjs — convert Markdown to Atlassian Document Format (ADF) JSON.
 *
 * Jira rich-text custom fields (Technical Approach, Steps to test, Acceptance Criteria,
 * Assumptions, Documentation Links) store ADF, not Markdown. The fnd write-back skills
 * run the APPROVED markdown through this script and pass the resulting ADF object to
 * editJiraIssue — so content renders correctly instead of showing literal `#`/`*`/`|`.
 * Comments take the same output serialized as a string (addCommentToJiraIssue with
 * contentFormat "adf"): the MCP's own markdown path leaves bare URLs inert. Dependency-free
 * (Node only); deterministic, so the model never hand-builds ADF JSON.
 *
 * Usage:
 *   node md-to-adf.cjs <file.md>         # read from a file
 *   node md-to-adf.cjs                   # read Markdown from stdin
 *   ... | node md-to-adf.cjs
 *   node md-to-adf.cjs --no-tables f.md  # render GFM tables as compact bullet lists
 *   node md-to-adf.cjs --pretty f.md     # 2-space indented JSON (debugging only)
 * Prints the ADF document JSON to stdout (MINIFIED by default).
 *
 * Exit codes: 0 = ADF written to stdout; 1 = the input could not be read; 2 = usage error
 * (unknown option, more than one file) or an input that yields no ADF blocks. On 1 and 2
 * stdout stays EMPTY. An empty source must not convert quietly: `{"content":[]}` is invalid
 * ADF (a doc needs a block), and a caller that writes it wipes the Jira field while its
 * read-back check — "every heading of the source is present" — passes vacuously on nothing.
 *
 * KEEP IT COMPACT. The output goes straight into an editJiraIssue tool call; a huge ADF blob
 * is fragile to inline (one typo breaks the structure) — which tempts deviating to a raw
 * markdown string, which Jira custom fields REJECT ("Operation value must be an Atlassian
 * Document"). Two levers keep it small: (1) output is minified, not pretty-printed (≈half the
 * bytes); (2) `--no-tables` renders GFM tables as bullet lists — ADF `table` nodes are by far
 * the heaviest construct (every cell wraps a paragraph).
 *
 * stderr (never stdout) carries, on every successful run, `md-to-adf: <n> bytes` — the byte
 * length of the MINIFIED JSON, newline excluded, always the minified size, even under `--pretty`,
 * whose stdout is larger — plus a size warning when the ADF is large, so you trim/restructure
 * instead of shipping a fragile blob.
 *
 * Supported: headings (#..######), paragraphs, **bold**, *italic*, ***bold-italic***, `inline code`,
 * [links](url), <autolinks>, bare https:// http:// mailto: URLs (GFM extended autolinks —
 * trailing sentence punctuation stays prose), ~~strike~~, nested inline marks (**bold `code`**, **[link](u)**),
 * hard line breaks (two trailing spaces or a trailing backslash), bullet/ordered lists,
 * ``` fenced code blocks ```, --- horizontal rules, > blockquotes (which hold BLOCKS — a quoted
 * fence, list or second paragraph survives; a construct ADF forbids inside a quote degrades to
 * paragraph text), and GFM pipe tables.
 * Underscore emphasis (_x_/__x__) is intentionally NOT treated as italics/bold so
 * snake_case identifiers survive; use * / ** for emphasis.
 *
 * Backslash escapes follow CommonMark: the backslash is dropped in front of any of
 * \ ` * _ # + - . > | ~ [ ] anywhere in the input. That covers every marker adf-to-md.cjs
 * escapes on the way out (\# \- 1\. \> \` \| …), so an ADF → markdown → ADF round trip keeps
 * literal prose literal instead of promoting it to a heading/list/fence — and it means a
 * backslash an author typed in front of one of those characters (`\.` in a regex, `\[`) is
 * consumed, exactly as any CommonMark parser would. A backslash before anything else (`\d`,
 * `\(`, a Windows path separator) is untouched.
 */
'use strict';
const fs = require('fs');

const ARGV = process.argv.slice(2);
const USAGE = 'usage: md-to-adf.cjs [--no-tables] [--pretty] [file.md]';
// Warn above this serialized size — large field values are fragile to write back via one tool call.
const SIZE_WARN_BYTES = 30000;

function usageError(msg) {
  process.stderr.write('md-to-adf: ' + msg + '\n' + USAGE + '\n');
  process.exit(2);
}

// A dashed argument this script does not know is a MISTAKE, not a filename: silently ignoring
// it (or reading it as the source path) is how `--notables` or `--strip-comments` ends up
// converting the wrong thing — or nothing at all.
const OPT = { noTables: false, pretty: false };
const FILES = [];
for (const a of ARGV) {
  if (a === '--no-tables') OPT.noTables = true;
  else if (a === '--pretty') OPT.pretty = true;
  else if (a.startsWith('-')) usageError('unknown option ' + a);
  // `"$SRC"` with SRC unset is "" — a fall-through to stdin here converts whatever is on it
  else if (a === '') usageError('empty file argument');
  else FILES.push(a);
}
if (FILES.length > 1) usageError('too many file arguments (' + FILES.join(', ') + ')');
const FILE_ARG = FILES[0];
const SOURCE = FILE_ARG || 'stdin';

// A reader that goes away mid-write (`| head`, a spawned parent that destroys the pipe) is
// success, not failure: the EPIPE (Windows: `code: 'EOF'`) surfaces async and would otherwise
// crash the process after the consumer already got its bytes.
const quietOnEpipe = (s) => s.on('error', (e) => {
  if (e && (e.code === 'EPIPE' || e.code === 'EOF')) process.exit(0);
  throw e;
});
quietOnEpipe(process.stdout);
quietOnEpipe(process.stderr);

function readInput() {
  try {
    // A leading BOM is an encoding artifact, not content: left in, it becomes the first text
    // node of the document (and makes a BOM-only file look like a paragraph).
    const raw = FILE_ARG ? fs.readFileSync(FILE_ARG, 'utf8') : fs.readFileSync(0, 'utf8');
    return raw.replace(/^\uFEFF/, '');
  } catch (e) {
    process.stderr.write('md-to-adf: cannot read input: ' + e.message + '\n');
    process.exit(1);
  }
}

// Blank by the block parser's own rule (BLANK_RE, ASCII-only — an NBSP is content the Jira
// editor inserted, so an NBSP-only source is a real, if thin, document).
const isBlank = (s) => !/[^ \t\r\n]/.test(s);

function textNode(text, marks) {
  if (text === '') return null;
  const n = { type: 'text', text };
  if (marks && marks.length) n.marks = marks;
  return n;
}

// CommonMark punctuation escapes, a superset of the markers adf-to-md writes. A backslash in
// front of a character OUTSIDE this set (a regex `\d`, LaTeX `\(`, a Windows path separator) is
// left alone; in front of one INSIDE it the backslash is consumed, which is why adf-to-md
// doubles a literal backslash standing there — that is what makes the round trip lossless.
const ESCAPABLE = '\\`*_#+-.>|~[]';
const UNESCAPE_RE = /\\([\\`*_#+\-.>|~[\]])/g;
// JS `\s` matches U+00A0, but the NBSP the Jira editor inserts is content, not padding — so
// every trim here is ASCII-only. The class is `[ \t]`, narrower than adf-to-md's `[ \t\n]`,
// because this side only ever trims a single line (the input is split on newlines first).
const trimAscii = (s) => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
// A link target carries escapes too (adf-to-md escapes the pipes of an href inside a table
// cell), and they belong to the markdown, not to the URL.
const unescapeHref = (href) => href.replace(UNESCAPE_RE, '$1');

// ADF rejects strong/em/strike alongside `code` — only a link may wrap a code span — so
// an incompatible outer mark is dropped instead of leaking back as literal backticks.
const CODE_COMPATIBLE = ['code', 'link'];
function mergeMarks(marks, ...add) {
  const out = [];
  for (const m of marks.concat(add)) if (!out.some((x) => x.type === m.type)) out.push(m);
  return out.some((m) => m.type === 'code') ? out.filter((m) => CODE_COMPATIBLE.includes(m.type)) : out;
}

// the length bound matters at `i >= s.length`, where `undefined === undefined` would spin forever
const runLength = (s, i) => { let n = 0; while (i + n < s.length && s[i + n] === s[i]) n++; return n; };

// Code span, CommonMark rule: an opening run of N backticks closes on the next run of
// EXACTLY N, so ``a ` b`` keeps the inner tick as content. Null = unclosed run (literal).
function scanCode(s, i) {
  const open = runLength(s, i);
  let j = i + open;
  while (j < s.length) {
    if (s[j] !== '`') { j++; continue; }
    const run = runLength(s, j);
    if (run === open) {
      let text = s.slice(i + open, j);
      // one space on each side is a delimiter artifact (adf-to-md pads content that itself
      // starts or ends with a backtick or a space), not content
      if (/^ /.test(text) && / $/.test(text) && text.trim() !== '') text = text.slice(1, -1);
      return { text, end: j + run };
    }
    j += run;
  }
  return null;
}

// Bracket and paren PAIRS for one inline string, matched in a single left-to-right pass that
// skips escapes and code spans (CommonMark resolves code spans before link brackets, so a
// bracket inside one is not a label bracket). Precomputing them is what keeps scanLink O(1) per
// candidate: re-scanning the tail for every unmatched `[` or `(` is quadratic on ordinary prose
// full of globs and half-written links.
function pairIndex(s) {
  const brackets = new Map();
  const parens = new Map();
  const bStack = [];
  const pStack = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '`') {
      const span = scanCode(s, i);
      i = span ? span.end : i + runLength(s, i); // an unclosed run is literal
      continue;
    }
    if (c === '[') bStack.push(i);
    else if (c === ']') { const o = bStack.pop(); if (o !== undefined) brackets.set(o, i); }
    else if (c === '(') pStack.push(i);
    else if (c === ')') { const o = pStack.pop(); if (o !== undefined) parens.set(o, i); }
    i++;
  }
  return { brackets, parens };
}

// [label](href). The label may hold balanced brackets and a code span; a bare target must have
// balanced parens and no whitespace, and the <…> form takes anything up to its `>`.
function scanLink(s, i, pairs) {
  const j = pairs.brackets.get(i);
  if (j === undefined || s[j + 1] !== '(') return null;
  const label = s.slice(i + 1, j);
  if (!label) return null;
  const k = j + 2;
  if (s[k] === '<') {
    const close = s.indexOf('>', k + 1);
    if (close === -1 || s[close + 1] !== ')') return null;
    return { label, href: unescapeHref(s.slice(k + 1, close)), end: close + 2 };
  }
  const close = pairs.parens.get(j + 1);
  if (close === undefined || close === k) return null; // unbalanced, or an empty target
  const href = s.slice(k, close);
  if (/[ \t\n]/.test(href)) return null; // a bare target can't hold whitespace
  return { label, href: unescapeHref(href), end: close + 1 };
}

// <scheme:target> autolink — the form adf-to-md emits for a smart-link card and for a link whose
// visible text is its own href. Without it the URL lands in the field as inert prose.
const AUTOLINK_RE = /^[a-z][a-z0-9+.\-]*:[^\s<>]+$/i;
function scanAutolink(s, i) {
  const close = s.indexOf('>', i + 1);
  if (close === -1) return null;
  const body = s.slice(i + 1, close);
  return AUTOLINK_RE.test(body) ? { href: body, end: close + 1 } : null;
}

// Bare `https://…` in prose, the GFM extended-autolink subset — what a developer pastes
// (a preview-theme URL, a Figma link). Without it the URL lands in Jira as inert text.
// Only well-known schemes, so `foo:bar` prose is never linkified; the run must start a word
// (line start, whitespace, or a delimiter GFM allows: * _ ~ ( and a quote) and ends at
// whitespace or `<`. Trailing punctuation belongs to the sentence, not the URL, and a
// closing paren is dropped only when nothing inside the URL opened it (`(see https://x.dev)`
// vs `https://en.wikipedia.org/wiki/Foo_(bar)`). Escapes inside the run are consumed the
// same way as in prose, so a `\_` from another converter's escaping is not a URL character.
const BARE_URL_RE = /(?:https?:\/\/|mailto:)[^\s<]+/iy;
const BARE_URL_BOUNDARY_RE = /[ \t\n*_~("']/;
const TRAILING_PUNCT = '?!.,:;*~_"\'';
function scanBareUrl(s, i) {
  if (i > 0 && !BARE_URL_BOUNDARY_RE.test(s[i - 1])) return null;
  BARE_URL_RE.lastIndex = i;
  const m = BARE_URL_RE.exec(s);
  if (!m) return null;
  let end = i + m[0].length;
  let open = 0;
  for (let k = i; k < end; k++) { if (s[k] === '(') open++; else if (s[k] === ')') open--; }
  while (end > i && s[end - 2] !== '\\') {
    const c = s[end - 1];
    if (TRAILING_PUNCT.includes(c)) end--;
    else if (c === ')' && open < 0) { end--; open++; }
    else break;
  }
  const href = unescapeHref(s.slice(i, end));
  if (!/^(?:https?:\/\/|mailto:)./i.test(href)) return null; // a bare scheme is prose
  return { href, end };
}

// Find the closing delimiter run for an opener of `n` × `ch`, skipping escapes and code spans.
// The closer must be a run of EXACTLY n, so both runs are consumed WHOLE (`**a *b* c**` closes
// on the final `**`, `*a **b** c*` on the final `*`). Matching a longer run and taking n
// characters off its front leaves a surplus delimiter behind, which the next pass reads as
// literal text — the field then gains `*` characters on every read-edit-write cycle.
// A closer may not hug whitespace either (`~~ old ~~` is literal markup, like `** bold **`).
function findCloser(s, from, ch, n) {
  let j = from;
  while (j < s.length) {
    const c = s[j];
    if (c === '\\') { j += 2; continue; }
    if (c === '`') { const sp = scanCode(s, j); if (sp) { j = sp.end; continue; } }
    if (c === ch) {
      const run = runLength(s, j);
      if (run === n && j > from && !/[ \t\n]/.test(s[j - 1])) return j;
      j += run;
      continue;
    }
    j++;
  }
  return -1;
}

// CommonMark pairs a closer with the NEAREST opener before it. An opener that a later one
// shadows therefore has to stay literal: otherwise an intraword run steals the real opener's
// closer, and the mark covers the wrong text with the run's own characters deleted
// (`2**3 is 8 and **bold** text` loses the `**` of `2**3` and marks `3 is 8 and **bold`).
function shadowedOpener(s, from, to, ch, n) {
  let j = from;
  while (j < to) {
    const c = s[j];
    if (c === '\\') { j += 2; continue; }
    if (c === '`') { const sp = scanCode(s, j); if (sp) { j = sp.end; continue; } }
    if (c === ch) {
      const run = runLength(s, j);
      if (run === n && j + run < to && !/[ \t\n]/.test(s[j + run])) return true;
      j += run;
      continue;
    }
    j++;
  }
  return false;
}

// `noClose` memoises openers that found no closer. Openers are visited left to right, so a
// failure for (ch, run) proves there is no such closer in the REST of the string either — and
// without the memo every unclosable `*` re-scans the tail.
function scanEmph(s, i, noClose) {
  const ch = s[i];
  const run = runLength(s, i);
  // emphasis requires non-space flanks so formulas and globs in prose
  // (`a * b`, `SELECT *`, `2 ** 3`) never turn into stray marks with eaten asterisks
  const nxt = s[i + run];
  if (ch === '~' ? run < 2 : nxt === undefined || /[ \t\n]/.test(nxt)) return null;
  const key = ch + run;
  if (noClose.has(key)) return null;
  const close = findCloser(s, i + run, ch, run);
  if (close === -1) { noClose.add(key); return null; }
  if (shadowedOpener(s, i + run, close, ch, run)) return null;
  const inner = s.slice(i + run, close);
  if (!inner) return null; // `****` — nothing to mark, so the run is literal
  const n = Math.min(run, 3);
  const marks = ch === '~' ? [{ type: 'strike' }]
    : n === 3 ? [{ type: 'strong' }, { type: 'em' }]
      : n === 2 ? [{ type: 'strong' }] : [{ type: 'em' }];
  return { inner, end: close + run, marks };
}

// A link label and a mark's content are parsed by RECURSION, one stack frame and one bracket-pair
// scan per level, so markdown carrying thousands of nested `[` would overflow the stack — and a
// crash means NO ADF at all, which is worse than ADF that keeps a construct literal. Past this
// depth the remaining content stays text; real prose never nests marks more than a few deep.
const MAX_INLINE_DEPTH = 24;

// Inline parser → array of ADF inline nodes. RECURSIVE: the outer mark is merged onto the
// nodes parsed out of its content, so **bold `code`** / **[link](u)** / **bold *it***
// keep every mark instead of leaking literal markdown into the Jira field.
function inlineNodes(input, marks, depth) {
  marks = marks || [];
  depth = depth || 0;
  if (depth >= MAX_INLINE_DEPTH) { const n = textNode(input, marks); return n ? [n] : []; }
  const out = [];
  const pairs = pairIndex(input);
  const noClose = new Set();
  let buf = '';
  const flush = () => { const n = textNode(buf, marks); if (n) out.push(n); buf = ''; };
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === '\\' && ESCAPABLE.includes(input[i + 1])) { buf += input[i + 1]; i += 2; continue; }
    if (ch === '`') {
      const span = scanCode(input, i);
      if (span) {
        flush();
        const n = textNode(span.text, mergeMarks(marks, { type: 'code' }));
        if (n) out.push(n);
        i = span.end;
        continue;
      }
    } else if (ch === '[') {
      const l = scanLink(input, i, pairs);
      if (l) {
        flush();
        out.push(...inlineNodes(l.label, mergeMarks(marks, { type: 'link', attrs: { href: l.href } }), depth + 1));
        i = l.end;
        continue;
      }
    } else if (ch === '<') {
      const a = scanAutolink(input, i);
      if (a) {
        flush();
        const n = textNode(a.href, mergeMarks(marks, { type: 'link', attrs: { href: a.href } }));
        if (n) out.push(n);
        i = a.end;
        continue;
      }
    } else if (ch === '*' || ch === '~') {
      const e = scanEmph(input, i, noClose);
      if (e) {
        flush();
        out.push(...inlineNodes(e.inner, mergeMarks(marks, ...e.marks), depth + 1));
        i = e.end;
        continue;
      }
    } else if (ch === 'h' || ch === 'H' || ch === 'm' || ch === 'M') {
      const u = scanBareUrl(input, i);
      if (u) {
        flush();
        const n = textNode(u.href, mergeMarks(marks, { type: 'link', attrs: { href: u.href } }));
        if (n) out.push(n);
        i = u.end;
        continue;
      }
    }
    // an unmatched delimiter is literal: consume the whole run so the next iteration
    // can't re-open it one character in
    const step = ch === '`' || ch === '*' || ch === '~' ? runLength(input, i) : 1;
    buf += input.slice(i, i + step);
    i += step;
  }
  flush();
  return out;
}

// Two trailing spaces (or a trailing backslash) is a markdown HARD line break → hardBreak
// node; every other wrapped line is a soft break, which ADF represents by joining the
// lines with a space.
function inlineLines(lines) {
  const segments = [[]];
  lines.forEach((raw, k) => {
    let text = raw;
    let hard = false;
    if (k < lines.length - 1) {
      if (/[ \t]{2}$/.test(text)) hard = true;
      else if (/(?<!\\)\\$/.test(text)) { hard = true; text = text.slice(0, -1); }
    }
    segments[segments.length - 1].push(hard ? text.replace(/[ \t]+$/, '') : text);
    if (hard) segments.push([]);
  });
  const out = [];
  segments.forEach((seg, k) => {
    if (k) out.push({ type: 'hardBreak' });
    out.push(...inlineNodes(seg.join(' ').replace(/[ \t]+$/, '')));
  });
  return out;
}

// Jira's ADF validator can reject an empty `content` array — omit the key instead (heading,
// paragraph and codeBlock all take this shape).
function para(nodes) { return nodes.length ? { type: 'paragraph', content: nodes } : { type: 'paragraph' }; }
function heading(level, nodes) {
  const n = { type: 'heading', attrs: { level } };
  if (nodes.length) n.content = nodes;
  return n;
}
// An info string can't contain backticks, so ```x``` is a code SPAN, not a fence. A fence may be
// INDENTED (inside a list, under a bullet in a reference doc) — unrecognized, its body would be
// read as prose, and the inline layer would then rewrite the code (eat a `\+`, turn a trailing
// backslash into a line break).
const FENCE_RE = /^([ \t]*)(`{3,})([^`]*)$/;
const PIPE_RE = /(?<!\\)\|/;
// A GFM separator row — the line under a table header. It has to carry a pipe of its own, or a
// bare `---` under prose would read as a table separator instead of a horizontal rule.
const SEP_RE = /^[ \t]*\|?[ \t:]*-{1,}[-\t :|]*$/;
const BLANK_RE = /^[ \t]*$/;
// CommonMark drops from each body line as much leading whitespace as the OPENING fence carries —
// no more, so relative indentation inside the block survives.
function stripIndent(line, n) {
  let k = 0;
  while (k < n && (line[k] === ' ' || line[k] === '\t')) k++;
  return line.slice(k);
}
// A pipe separates cells only when it is unescaped AND outside a `code span` — anywhere
// else it is the cell's own text (adf-to-md escapes exactly the structural ones).
function splitCells(row) {
  const out = [];
  let cur = '';
  let i = 0;
  while (i < row.length) {
    const ch = row[i];
    if (ch === '\\') { cur += row.slice(i, i + 2); i += 2; continue; }
    if (ch === '`') {
      const span = scanCode(row, i);
      const end = span ? span.end : i + runLength(row, i); // unclosed run: literal
      cur += row.slice(i, end);
      i = end;
      continue;
    }
    if (ch === '|') { out.push(cur); cur = ''; i++; continue; }
    cur += ch;
    i++;
  }
  out.push(cur);
  return out;
}
function cellsOf(line) {
  const row = trimAscii(line).replace(/^\|/, '').replace(/(?<!\\)\|$/, '');
  return splitCells(row).map(trimAscii);
}
// `next` decides the table rule: a pipe row only starts a block when a SEPARATOR row follows it.
// Without that lookahead a pipeless GFM table under prose is swallowed into the paragraph, and
// treating any leading pipe as a row tears a wrapped prose line (and its hard break) out of one.
function isBlockStart(line, next) {
  return BLANK_RE.test(line)
    || /^(#{1,6})(\s+|$)/.test(line)
    || FENCE_RE.test(line)
    || /^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)
    || /^\s*([-*+])(\s|$)/.test(line)
    || /^\s*\d+\.(\s|$)/.test(line)
    || /^\s*>\s?/.test(line)
    || (PIPE_RE.test(line) && next != null && PIPE_RE.test(next) && SEP_RE.test(next));
}

// ADF's blockquote content model admits only paragraph | bulletList | orderedList | codeBlock |
// mediaGroup | mediaSingle | extension. Jira REJECTS the whole document otherwise, so one quoted
// heading would fail an entire editJiraIssue write — hence `quoted`, which turns off the block
// rules whose node types a blockquote cannot hold. Those lines fall through to the paragraph
// gatherer, keeping their marker as literal text (adf-to-md escapes it again on the way out).
// It also means the quote body is parsed ONCE: a line of nothing but `>` cannot recurse.
function toADF(md, quoted) {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const content = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (BLANK_RE.test(line)) { i++; continue; }

    // fenced code block — any info string opens a fence (```c++, ```shell session, …);
    // the language is its first word. A body containing ``` needs a LONGER fence, so the
    // closing run only counts when it is at least as long as the opening one.
    const fence = FENCE_RE.exec(line);
    if (fence) {
      const info = fence[3].trim();
      const lang = info ? info.split(/\s+/)[0] : null;
      const closeRe = new RegExp('^[ \\t]*`{' + fence[2].length + ',}[ \\t]*$');
      const buf = [];
      i++;
      while (i < lines.length && !closeRe.test(lines[i])) { buf.push(stripIndent(lines[i], fence[1].length)); i++; }
      i++; // closing fence
      const text = buf.join('\n');
      const node = { type: 'codeBlock' };
      if (lang) node.attrs = { language: lang };
      if (text) node.content = [{ type: 'text', text }];
      content.push(node);
      continue;
    }

    // heading — a bare `#` is an EMPTY heading, not prose
    const h = quoted ? null : /^(#{1,6})(?:\s+(.*))?$/.exec(line);
    if (h) { content.push(heading(h[1].length, inlineNodes(trimAscii(h[2] || '')))); i++; continue; }

    // horizontal rule
    if (!quoted && /^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { content.push({ type: 'rule' }); i++; continue; }

    // GFM table: this row has a pipe and the next row is a separator (---|---).
    if (!quoted && PIPE_RE.test(line) && i + 1 < lines.length && PIPE_RE.test(lines[i + 1]) && SEP_RE.test(lines[i + 1])) {
      const header = cellsOf(line);
      i += 2; // header + separator
      const dataRows = [];
      while (i < lines.length && PIPE_RE.test(lines[i]) && !BLANK_RE.test(lines[i])) {
        dataRows.push(cellsOf(lines[i]));
        i++;
      }
      // ADF tables must be rectangular — pad ragged rows (and a short header) with empty cells
      const width = Math.max(header.length, ...dataRows.map((r) => r.length));
      while (header.length < width) header.push('');
      for (const r of dataRows) while (r.length < width) r.push('');
      if (OPT.noTables) {
        // Compact form: one bullet per data row, "Header: cell · Header: cell".
        // ADF table nodes are the heaviest construct; this keeps the field small and robust.
        // Labels are PLAIN text (not bold) so each cell stays a single text node — bold marks
        // would double the node count per cell and can make a wide table LARGER than the table form.
        const items = dataRows.map((cells) => {
          const parts = cells
            .map((c, j) => {
              const key = trimAscii(header[j] || '');
              if (c === '' && !key) return '';
              return key ? `${key}: ${c}` : c;
            })
            .filter((s) => s !== '');
          return { type: 'listItem', content: [para(inlineNodes(parts.join(' · ')))] };
        }).filter((it) => it.content[0].content && it.content[0].content.length);
        content.push({ type: 'bulletList', content: items.length ? items : [{ type: 'listItem', content: [para([])] }] });
      } else {
        const rows = [{
          type: 'tableRow',
          content: header.map((c) => ({ type: 'tableHeader', content: [para(inlineNodes(c))] })),
        }];
        for (const cells of dataRows) {
          rows.push({
            type: 'tableRow',
            content: cells.map((c) => ({ type: 'tableCell', content: [para(inlineNodes(c))] })),
          });
        }
        content.push({ type: 'table', content: rows });
      }
      continue;
    }

    // blockquote — the de-prefixed lines are parsed as BLOCKS, so a quote can hold a fence or a
    // list and two quoted paragraphs stay two paragraphs
    if (!quoted && /^\s*>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
      const inner = toADF(buf.join('\n'), true).content;
      content.push({ type: 'blockquote', content: inner.length ? inner : [para([])] });
      continue;
    }

    // lists — nested by indentation: an item indented 2+ spaces past its parent item
    // nests inside that parent's listItem (ADF supports it); shallower indents pop back
    // a bare marker is an EMPTY item — adf-to-md emits one for an empty listItem, and
    // literal `-`/`1.` prose arrives escaped, so this can't swallow a paragraph
    const LIST_RE = /^(\s*)([-*+]|\d+\.)(?:\s+(.*))?$/;
    if (LIST_RE.test(line)) {
      const stack = []; // { indent, list, lastItem, ordered }
      while (i < lines.length) {
        const m = LIST_RE.exec(lines[i]);
        if (!m) break;
        const indent = m[1].replace(/\t/g, '  ').length;
        const ordered = /^\d/.test(m[2]);
        const item = { type: 'listItem', content: [para(inlineNodes(trimAscii(m[3] || '')))] };
        while (stack.length && indent < stack[stack.length - 1].indent) stack.pop();
        let top = stack[stack.length - 1];
        if (top && ordered === top.ordered && indent < top.indent + 2) {
          top.list.content.push(item); // sibling item
          top.lastItem = item;
        } else {
          const list = { type: ordered ? 'orderedList' : 'bulletList', content: [item] };
          if (ordered) {
            const start = parseInt(m[2], 10);
            if (start !== 1) list.attrs = { order: start }; // preserve lists starting at e.g. "3."
          }
          if (top && indent >= top.indent + 2) {
            top.lastItem.content.push(list); // nested under the previous item
          } else {
            // same level but the marker type changed → sibling list of the other type
            if (top) { stack.pop(); top = stack[stack.length - 1]; }
            if (top) top.lastItem.content.push(list);
            else content.push(list);
          }
          stack.push({ indent, list, lastItem: item, ordered });
        }
        i++;
      }
      continue;
    }

    // paragraph (gather wrapped lines)
    const buf = [line];
    i++;
    while (i < lines.length && !isBlockStart(lines[i], lines[i + 1])) { buf.push(lines[i]); i++; }
    content.push(para(inlineLines(buf)));
  }
  return { type: 'doc', version: 1, content };
}

const md = readInput();
if (isBlank(md)) {
  process.stderr.write('md-to-adf: error: empty input (' + SOURCE + ')\n');
  process.exit(2);
}

const adf = toADF(md);
// Backstop: every non-blank line the block parser sees pushes a node, so nothing reaches this
// today — but a doc with no blocks is invalid ADF, and shipping one silently empties a field.
if (adf.content.length === 0) {
  process.stderr.write('md-to-adf: error: input produced no ADF blocks (' + SOURCE + ')\n');
  process.exit(2);
}

const min = JSON.stringify(adf);
const bytes = Buffer.byteLength(min, 'utf8');

// The caller reports this number verbatim instead of estimating it, so it is a real
// per-document fingerprint rather than a guess.
process.stderr.write('md-to-adf: ' + bytes + ' bytes\n');

// Size guardrail: a large field value is fragile to inline into one editJiraIssue call. Warn so
// the caller trims/restructures (shorter content, --no-tables) instead of falling back to raw
// markdown (which Jira custom fields reject). Warning goes to stderr; stdout stays pure JSON.
const hasTables = min.includes('"type":"table"');
if (bytes > SIZE_WARN_BYTES || (hasTables && bytes > SIZE_WARN_BYTES / 2)) {
  process.stderr.write(
    'md-to-adf: warning: ADF is ' + bytes + ' bytes' + (hasTables ? ' and contains table node(s)' : '') +
    '. Large/table-heavy field values are fragile to write back in one tool call — ' +
    'consider --no-tables and trimming the content (headings + bullet lists stay compact).\n'
  );
}

process.stdout.write((OPT.pretty ? JSON.stringify(adf, null, 2) : min) + '\n');
