#!/usr/bin/env node
/*
 * adf-to-md.cjs — convert Atlassian Document Format (ADF) JSON to Markdown.
 *
 * The inverse of md-to-adf.cjs. Jira rich-text CUSTOM fields (Technical Approach, Steps to
 * test, Acceptance Criteria, Assumptions, Documentation Links) come back as raw ADF even when
 * getJiraIssue is called with responseContentFormat:"markdown" (that only converts standard
 * description/comment fields). The fnd reading path (jira-reader) runs those ADF values through
 * this so it gets clean markdown deterministically instead of hand-walking nested JSON — and
 * keeps the bulky raw ADF out of context.
 *
 * Usage:
 *   node adf-to-md.cjs <file.json>                      # an ADF doc, OR a full getJiraIssue response
 *   node adf-to-md.cjs <issue.json> --field customfield_10038   # extract that field's ADF first
 *   cat adf.json | node adf-to-md.cjs                   # stdin
 * Prints Markdown to stdout. Unknown node types degrade gracefully (render their children/text).
 *
 * The markdown is written so md-to-adf.cjs can read it BACK unchanged (the fnd flow reads a
 * field, edits it, writes it back): literal prose that starts with a structure marker is
 * backslash-escaped, code spans/fences use a delimiter longer than any run inside them,
 * a hard break ends a line with two spaces (or with a backslash where the line it starts would
 * otherwise be blank), and a cell's own pipes are escaped. Escaping covers the LEADING structure
 * markers, every backtick, and a `*`/`~` at a marked node's edge — not a `**`/`~~` standing in
 * prose, which deliberately comes back as a mark. Every escape here has its counterpart in
 * md-to-adf.cjs — change the two together.
 *
 * Nodes markdown cannot express INSIDE a single-line construct degrade instead of leaking their
 * delimiter: a hard break in a heading / list item / table cell becomes a space, and a code block
 * in a list item or a cell becomes a code span. A leaked fence never closes and would swallow
 * every block after it. A taskList / decisionList has no markdown form md-to-adf reads back as
 * one either: it is emitted as a bullet list (`- [ ]` / `- [x]` / `- `) and returns as a
 * bulletList whose text keeps a literal `[ ]`, which is stable from that cycle on — the marks
 * INSIDE the items (links above all) survive, which is what the reading path needs.
 *
 * Two normalizations the round trip cannot avoid, both because md-to-adf parses each
 * break-separated segment on its own so no mark may span a break: a newline INSIDE marked text
 * (including a code span) degrades to a space, and a newline inside unmarked text is emitted as a
 * hard break — so it returns as a hardBreak node rather than as text carrying a newline.
 * A third one is deliberate: a bare https:// URL sitting in UNLINKED text is not escaped here, so
 * md-to-adf reads it back as a GFM autolink and the field gains a `link` mark — a URL stored as
 * inert prose (an API writer that never linkified it) becomes clickable on the first write-back.
 */
'use strict';
const fs = require('fs');

function readJSON() {
  const args = process.argv.slice(2);
  const fi = args.indexOf('--field');
  const fieldId = fi !== -1 && args[fi + 1] && !args[fi + 1].startsWith('--') ? args[fi + 1] : null;
  if (fi !== -1 && !fieldId) {
    process.stderr.write('adf-to-md: --field needs a value (e.g. --field customfield_10038)\n');
    process.exit(1);
  }
  // skip the --field VALUE when looking for the input file arg
  const fileArg = args.find((a, i) => !a.startsWith('--') && (fi === -1 || i !== fi + 1));
  let raw;
  try {
    raw = fileArg ? fs.readFileSync(fileArg, 'utf8') : fs.readFileSync(0, 'utf8');
  } catch (e) {
    process.stderr.write('adf-to-md: cannot read input: ' + e.message + '\n');
    process.exit(1);
  }
  let data;
  try { data = JSON.parse(raw); } catch (e) {
    process.stderr.write('adf-to-md: input is not valid JSON: ' + e.message + '\n');
    process.exit(1);
  }
  if (fieldId) {
    const has = (o, k) => o && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
    if (!has(data.fields, fieldId) && !has(data, fieldId)) {
      process.stderr.write('adf-to-md: field ' + fieldId + ' not present in input\n');
      process.exit(1);
    }
    const val = has(data.fields, fieldId) ? data.fields[fieldId] : data[fieldId];
    if (val == null) {
      // genuinely empty field → empty output, never a fallback to another field or the whole doc
      process.stderr.write('adf-to-md: field ' + fieldId + ' is empty\n');
      process.exit(0);
    }
    if (typeof val === 'string') { process.stdout.write(val + '\n'); process.exit(0); }
    data = val;
  }
  return data;
}

// Find the ADF doc node if a wrapper object was passed.
function findDoc(node) {
  if (!node || typeof node !== 'object') return null;
  if (node.type === 'doc' && Array.isArray(node.content)) return node;
  for (const k of Object.keys(node)) {
    const found = findDoc(node[k]);
    if (found) return found;
  }
  return null;
}

// JS `\s` matches U+00A0, but an NBSP is content the author typed (the Jira editor inserts one
// for repeated spaces and around inline nodes), not droppable padding — so every trim on this
// side of the round trip is ASCII-only. md-to-adf.cjs strips `[ \t]` only: by the time it trims,
// the input is already split into lines, so there is no newline left to strip.
const trimAscii = (s) => s.replace(/^[ \t\n]+/, '').replace(/[ \t\n]+$/, '');

// A code span's delimiter — and a code block's fence — must be LONGER than any backtick run
// inside the body, or the span/block ends early.
const longestTickRun = (text) => (text.match(/`+/g) || []).reduce((n, r) => Math.max(n, r.length), 0);
// mirrors md-to-adf's runLength
const tickRun = (s, i) => /^`+/.exec(s.slice(i))[0].length;

// json-slim feeds this converter ADF straight off an MCP response, so `text` may be absent, null
// or not a string — and a crash there means NO markdown at all.
const textOf = (node) => (node && node.text != null ? String(node.text) : '');
const codeText = (node) => (node.content || []).map(textOf).join('');

// Content that itself starts/ends with a backtick or a space needs a padding space, which
// md-to-adf strips back off — but CommonMark only strips it when the content is not all
// whitespace, so padding all-space content would add two spaces per cycle and never converge.
function codeSpan(text) {
  const ticks = '`'.repeat(longestTickRun(text) + 1);
  const pad = /^[` ]|[` ]$/.test(text) && text.trim() !== '' ? ' ' : '';
  return ticks + pad + text + pad + ticks;
}

// A fence has no form a single-LINE construct can carry: leaked into a list item or a table cell
// it never closes and swallows every block after it, so the body becomes a code span (the
// language is dropped — a code span has no info string). Empty content has no span form at all
// (`` is an unclosed run), so it is dropped instead.
function codeBlockSpan(node) {
  const code = codeText(node);
  return code ? codeSpan(code) : '';
}

// Emphasis delimiters can't hug whitespace (`** bold **` is literal markdown), so the
// padding moves outside the marks instead of silently losing them on the way back.
const PADDED_RE = /^([ \t]*)([\s\S]*?)([ \t]*)$/;
function wrap(text, delim) {
  const m = PADDED_RE.exec(text);
  return m[2] ? m[1] + delim + m[2] + delim + m[3] : text;
}

// A `*` or `~` at the very EDGE of marked text fuses with the delimiter run wrap() puts there
// (`**` + `*.liquid` = `***.liquid`, which reads back as one unmarked node — the mark is gone and
// the text gained a character), so the edge character is escaped; md-to-adf's ESCAPABLE undoes it.
// Trailing first, so a one-character body is not escaped twice.
function escapeEdgeDelim(text) {
  const m = PADDED_RE.exec(text);
  let core = m[2];
  if (!core) return text;
  if (/[*~]$/.test(core)) core = core.slice(0, -1) + '\\' + core.slice(-1);
  if (/^[*~]/.test(core)) core = '\\' + core;
  return m[1] + core + m[3];
}

// A bare link target can hold neither whitespace nor unbalanced parens — md-to-adf reads
// those as literal text — so they go in the <…> form. An angle bracket inside such an href
// would end that form early, so it is percent-encoded: the URL still resolves, whereas the
// bare form would not parse at all and the whole link would degrade to prose.
function linkTarget(href) {
  let open = 0;
  for (const c of href) {
    if (c === '(') open++;
    else if (c === ')' && --open < 0) break;
  }
  if (!/[ \t\n]/.test(href) && open === 0) return href;
  return '<' + href.replace(/</g, '%3C').replace(/>/g, '%3E') + '>';
}

// A link whose visible text IS its target: the autolink form is what a smart-link card emits,
// so both come back as the same `link` mark instead of one of them becoming [u](u).
const AUTOLINK_RE = /^[a-z][a-z0-9+.\-]*:[^\s<>]+$/i;

// The markers md-to-adf.cjs unescapes — a literal backslash in front of one of these would
// come back as an escape, so it is doubled. It is doubled at the node's END too: the renderer
// appends its own delimiter (`]`, a backtick, `*`, `~`) right there, and a lone backslash
// before a newline reads back as a hard line break.
const LITERAL_BACKSLASH_RE = /\\(?=[\\`*_#+\-.>|~[\]\n]|$)/g;

// A GFM separator row promotes the line ABOVE it to a table header — and md-to-adf accepts a
// pipeless table — so a line that merely LOOKS like a separator has to be escaped too, or a
// paragraph is silently read back as a table. Same shape as md-to-adf's SEP_RE.
const SEP_LOOKALIKE_RE = /^\|?[ \t:]*-+[-\t :|]*$/;

// Prose that starts with a markdown structure marker would read back as a heading / list /
// quote / rule / table row, so the marker is backslash-escaped here and md-to-adf strips the
// backslash again. A leading fence needs no rule of its own (backticks are escaped everywhere).
function escapeLeading(line) {
  const ws = /^[ \t]*/.exec(line)[0];
  const body = line.slice(ws.length);
  const ord = /^(\d+)\.(?=\s|$)/.exec(body);
  if (ord) return ws + ord[1] + '\\.' + body.slice(ord[0].length);
  if (/^([-*+](?=\s|$)|#{1,6}(?=\s|$)|>|\||[-*_]{3,}[ \t]*$)/.test(body)) return ws + '\\' + body;
  // the backslash goes on the first dash, not the front: an alignment form starts with `:`,
  // which md-to-adf does not unescape, so a `\:` would stick and grow every cycle
  if (SEP_LOOKALIKE_RE.test(body)) return ws + body.replace('-', '\\-');
  return line;
}

// End index of the code span opening at `i` (opening run of N backticks closes on the next
// run of exactly N, like md-to-adf's scanner), or -1 when the run never closes.
function codeSpanEnd(s, i) {
  const open = tickRun(s, i);
  let j = i + open;
  while (j < s.length) {
    if (s[j] !== '`') { j++; continue; }
    const run = tickRun(s, j);
    if (run === open) return j + run;
    j += run;
  }
  return -1;
}

// A cell's own pipes would shift the column layout, so they are escaped (renderText has
// already doubled any literal backslash in front of them). Inside a `code span` nothing is
// escaped: md-to-adf's row splitter treats a pipe there as cell text, and a backslash
// inside a code span is literal.
function escapeCell(s) {
  let out = '';
  let i = 0;
  while (i < s.length) {
    if (s[i] === '\\') { out += s.slice(i, i + 2); i += 2; continue; } // already escaped
    if (s[i] === '`') {
      const run = tickRun(s, i);
      const end = codeSpanEnd(s, i);
      // an unclosed run is literal text — and must be escaped, or the row splitter pairs it
      // with a backtick in ANOTHER cell and swallows the pipe between them
      out += end === -1 ? '\\`'.repeat(run) : s.slice(i, end);
      i = end === -1 ? i + run : end;
      continue;
    }
    const next = s.slice(i).search(/[`\\]/);
    const stop = next === -1 ? s.length : i + next;
    out += s.slice(i, stop).replace(/\|/g, '\\|');
    i = stop;
  }
  return out;
}

// A newline a text node carries is line structure, so it is emitted as a hard BREAK: as a raw
// newline it would be a soft break, which comes back as a space, and read-edit-write would
// flatten the line. json-slim feeds this converter ADF straight off an MCP response, where a
// text node can carry newlines the Jira editor would never produce.
// Every line after the first begins a line by construction; the first one only when the caller
// says so — and a single-LINE construct has no break to emit at all.
function breakLines(text, atLineStart, singleLine) {
  const lines = text.split('\n');
  if (singleLine) return lines.map((l, k) => (k === 0 && atLineStart ? escapeLeading(l) : l)).join(' ');
  return lines.map((l, k) => {
    const esc = k || atLineStart ? escapeLeading(l) : l;
    if (k === lines.length - 1) return esc;
    // two trailing spaces on an otherwise blank line IS a whitespace-only line, which md-to-adf
    // reads as the end of the block — the backslash form keeps that line non-blank
    return esc + (esc === '' && (k || atLineStart) ? '\\\n' : '  \n');
  }).join('');
}

function renderText(node, atLineStart, singleLine) {
  const raw = textOf(node);
  let t = raw;
  const marks = node.marks || [];
  const has = (m) => marks.some((x) => x.type === m);
  // a code span carries no escapes at all (its content is literal); anywhere else only
  // UNMARKED text can be mistaken for block structure, since every mark emits a leading
  // delimiter of its own
  if (!has('code')) {
    t = t.replace(LITERAL_BACKSLASH_RE, '\\\\');
    // a literal backtick would open a code span and swallow everything up to the next one
    // — including whole link nodes — so unlike the other inline delimiters it is escaped
    t = t.replace(/`/g, '\\`');
    // md-to-adf parses each break-separated segment on its own, so no mark can span a break:
    // inside MARKED text the newline has to degrade to a space or the mark is lost outright
    t = marks.length ? t.replace(/\n/g, ' ') : breakLines(t, atLineStart, singleLine);
  } else {
    // CommonMark reads a newline inside a code span as a space, and nothing in there can be
    // escaped, so the newline degrades here rather than ending the block
    t = codeSpan(t.replace(/\n/g, ' '));
  }
  if (has('strike') || has('em') || has('strong')) t = escapeEdgeDelim(t);
  if (has('strike')) t = wrap(t, '~~');
  if (has('em')) t = wrap(t, '*');
  if (has('strong')) t = wrap(t, '**');
  const link = marks.find((m) => m.type === 'link');
  if (link && link.attrs && link.attrs.href) {
    if (marks.length === 1 && raw === link.attrs.href && AUTOLINK_RE.test(raw)) return '<' + raw + '>';
    t = '[' + t + '](' + linkTarget(link.attrs.href) + ')';
  }
  return t;
}

// Pull a URL off a smart-link / card node (inlineCard, blockCard, embedCard).
// Most carry attrs.url; some carry attrs.data.url (JSON-LD) instead. Never drop it.
function cardUrl(node) {
  const a = node.attrs || {};
  return a.url || (a.data && (a.data.url || (a.data['@id']))) || '';
}

// Jira splits one run of identically-marked text into several text nodes (edit history,
// spell-check ranges). Emitting each separately would put a delimiter boundary INSIDE the
// run (`*a**b*`), which reads back as a different mark — so identical neighbours merge.
// NUL as the separator: a mark's serialized attrs can hold any printable character, so only
// a byte JSON text can never contain keeps the key collision-proof. It has to be written as
// an escape — a raw NUL makes grep treat this whole file as binary and skip it silently.
const markKey = (marks) => (marks || [])
  .map((m) => m.type + (m.attrs ? JSON.stringify(m.attrs) : '')).sort().join('\u0000');
function mergeText(nodes) {
  const out = [];
  for (const n of nodes) {
    const prev = out[out.length - 1];
    if (n && n.type === 'text' && prev && prev.type === 'text' && markKey(prev.marks) === markKey(n.marks)) {
      out[out.length - 1] = Object.assign({}, prev, { text: textOf(prev) + textOf(n) });
    } else out.push(n);
  }
  return out;
}

// `atLineStart` tracks the positions where a leading marker in plain text would be read
// back as block structure: the start of the block, and right after a hardBreak.
function inline(nodes, atLineStart, singleLine) {
  if (!Array.isArray(nodes)) return '';
  const list = mergeText(nodes);
  // a TRAILING hard break has nothing to break to — md-to-adf drops it, and emitting one only
  // leaves a dangling delimiter at the end of the block
  while (list.length && list[list.length - 1] && list[list.length - 1].type === 'hardBreak') list.pop();
  let start = !!atLineStart;
  const parts = [];
  for (let i = 0; i < list.length; i++) {
    const n = list[i];
    const isBreak = !!n && n.type === 'hardBreak';
    let s;
    if (isBreak) {
      // a heading, a list item and a table cell are single-LINE constructs: a real break would
      // end the block and demote the rest of its content, so it degrades to a space
      s = singleLine ? ' '
        // a break that starts an EMPTY line has to use the backslash form: two trailing spaces
        // alone on a line IS a whitespace-only line, which md-to-adf reads as the end of the block
        : (start && i > 0 ? '\\\n' : '  \n');
    } else s = renderInline(n, start, singleLine);
    if (isBreak && !singleLine) start = true;
    else if (s !== '') start = s.endsWith('\n'); // a text node can end on a break of its own
    parts.push(s);
  }
  return parts.join('');
}

function renderInline(n, atLineStart, singleLine) {
  if (!n || typeof n !== 'object') return '';
  if (n.type === 'text') return renderText(n, atLineStart, singleLine);
  if (n.type === 'emoji') return (n.attrs && (n.attrs.shortName || n.attrs.text)) || '';
  if (n.type === 'mention') return (n.attrs && n.attrs.text) || '';
  if (n.type === 'inlineCard' || n.type === 'blockCard' || n.type === 'embedCard') {
    const u = cardUrl(n);
    return u ? '<' + u + '>' : '';
  }
  if (n.type === 'status') return '[' + ((n.attrs && n.attrs.text) || '') + ']';
  if (n.type === 'date') {
    const ts = n.attrs && Number(n.attrs.timestamp);
    return ts ? new Date(ts).toISOString().slice(0, 10) : '';
  }
  if (n.content) return inline(n.content, atLineStart, singleLine); // unknown inline wrapper
  return (n.attrs && (n.attrs.text || n.attrs.shortName)) || '';
}

const CHILD_LIST_RE = /^(bulletList|orderedList|taskList|decisionList)$/;

// a listItem usually holds one paragraph, but Jira nests child lists as sibling blocks —
// those must come out as their own indented lines, never space-joined into the parent item
function renderListItem(item, depth, marker) {
  const pad = '  '.repeat(depth);
  const inlineParts = [];
  const childLines = [];
  // a `text` child sitting DIRECTLY in the item (no paragraph wrapper) has to go through the
  // mark-aware inline(), or renderBlock degrades it to textOf() and its link href is gone
  let buf = [];
  const flush = () => {
    if (!buf.length) return;
    const s = inline(buf, true, true);
    if (s !== '') inlineParts.push(s);
    buf = [];
  };
  for (const b of item.content || []) {
    if (b && typeof b === 'object' && INLINE_TYPE_RE.test(b.type)) { buf.push(b); continue; }
    flush();
    if (b && CHILD_LIST_RE.test(b.type)) childLines.push(renderBlock(b, depth + 1));
    else if (b && b.type === 'codeBlock') {
      const span = codeBlockSpan(b);
      if (span) inlineParts.push(span);
    }
    else inlineParts.push(renderBlock(b, depth, true));
  }
  flush();
  // an item is ONE line: a newline a child block emitted (a nested table, a second paragraph)
  // would end the list and spill the rest out as a top-level block
  const text = trimAscii(inlineParts.join(' ').replace(/\n/g, ' '));
  return [pad + marker + text, ...childLines].join('\n');
}

// The inline node types renderInline knows. Everything else is a block: an unknown node that
// carries content keeps degrading through renderBlock (children, then '\n\n'), as before.
const INLINE_TYPE_RE = /^(text|hardBreak|emoji|mention|inlineCard|status|date)$/;

// Children that are INLINE go through the mark-aware inline(), never through textOf(): a
// `text` node carrying a link mark would otherwise come out as bare label text with the href
// dropped — the one thing the reading path must never lose.
// Parts, not a joined string: blockquote prefixes every part on its own and separates siblings
// with a bare `>`, which a pre-joined body cannot be split back into.
function renderMixedParts(nodes, depth, singleLine) {
  const parts = [];
  let buf = [];
  const flush = () => {
    if (!buf.length) return;
    const s = inline(buf, true, singleLine);
    if (s !== '') parts.push(s);
    buf = [];
  };
  for (const c of Array.isArray(nodes) ? nodes : []) {
    if (c && typeof c === 'object' && !INLINE_TYPE_RE.test(c.type)) {
      flush();
      parts.push(renderBlock(c, depth, singleLine));
    } else buf.push(c);
  }
  flush();
  return parts;
}

function renderMixed(nodes, depth, singleLine, joiner) {
  return renderMixedParts(nodes, depth, singleLine).join(joiner);
}

// A taskItem / decisionItem holds inline content directly (no wrapping paragraph); a block a
// nested editor put there is flattened, because the item is ONE line.
function renderItemLine(item, depth, marker) {
  const body = trimAscii(renderMixed(item && item.content, depth, true, ' ').replace(/\n/g, ' '));
  return '  '.repeat(depth) + marker + body;
}

// A nested taskList/decisionList is a SIBLING of the items, not a child of one.
function renderItemList(node, depth, markerOf) {
  return (node.content || []).map((it) => (it && it.type === node.type
    ? renderBlock(it, depth + 1)
    : renderItemLine(it, depth, markerOf(it)))).join('\n');
}

function renderBlock(node, depth, singleLine) {
  depth = depth || 0;
  if (!node || typeof node !== 'object') return '';
  switch (node.type) {
    case 'heading': {
      // markdown has no level > 6; clamp instead of emitting `#########`
      const lvl = Math.min(Math.max((node.attrs && node.attrs.level) || 1, 1), 6);
      // the marker eats surrounding whitespace on the way back, so it is trimmed here;
      // a bare `#` keeps an EMPTY heading a heading (with a trailing space the final trim
      // would turn it into prose)
      const body = trimAscii(inline(node.content, false, true));
      return '#'.repeat(lvl) + (body ? ' ' + body : '');
    }
    case 'paragraph':
      return inline(node.content, true, singleLine);
    case 'bulletList':
      return (node.content || []).map((li) => renderListItem(li, depth, '- ')).join('\n');
    case 'orderedList': {
      let i = (node.attrs && node.attrs.order) || 1;
      return (node.content || []).map((li) => renderListItem(li, depth, (i++) + '. ')).join('\n');
    }
    case 'taskList':
      // markdown has no checklist ADF can read back: md-to-adf returns a bulletList whose text
      // starts with a literal `[ ]`/`[x]`, which is stable across further cycles
      return renderItemList(node, depth, (it) =>
        (it && it.attrs && it.attrs.state === 'DONE' ? '- [x] ' : '- [ ] '));
    case 'decisionList':
      // no "Decision:" prefix — that would be prose the author never wrote, and it would
      // survive the round trip as real text
      return renderItemList(node, depth, () => '- ');
    case 'codeBlock': {
      const lang = (node.attrs && node.attrs.language) || '';
      const text = codeText(node);
      // the fence must be LONGER than the longest backtick run in the body, or an inner
      // ``` closes the block early and the rest of the document leaks out as prose
      const fence = '`'.repeat(Math.max(3, longestTickRun(text) + 1));
      return fence + lang + '\n' + text + '\n' + fence;
    }
    case 'blockquote':
      // prefix EVERY line — a child block that renders multi-line (hard break, code)
      // would otherwise fall out of the quote — and separate siblings with a bare `>`, or two
      // quoted paragraphs read back as one and a quoted rule/table as literal text
      // …and inline children sitting directly in the quote go through inline() as one run, or a
      // link in an unwrapped `text` child comes back as bare label text
      return renderMixedParts(node.content, depth + 1, false)
        .map((s) => s.split('\n').map((l) => '> ' + l).join('\n')).join('\n>\n');
    case 'rule':
      return '---';
    case 'table': {
      const rows = node.content || [];
      if (!rows.length) return '';
      // render EVERY block of a cell (a Jira cell can hold several paragraphs / a list);
      // depth 0 — cells flatten to one line anyway, indentation would only add noise.
      const cellsOf = (row) => (row.content || []).map((c) =>
        trimAscii(escapeCell((c.content || []).map((b) => (b && b.type === 'codeBlock'
          ? codeBlockSpan(b) : renderBlock(b, 0, true))).join(' ')).replace(/\n/g, ' ')));
      const out = [];
      const head = cellsOf(rows[0]);
      out.push('| ' + head.join(' | ') + ' |');
      out.push('| ' + head.map(() => '---').join(' | ') + ' |');
      for (let r = 1; r < rows.length; r++) out.push('| ' + cellsOf(rows[r]).join(' | ') + ' |');
      return out.join('\n');
    }
    case 'blockCard':
    case 'embedCard': {
      // A Jira "smart link" pasted on its own line (e.g. a Notion / Figma / Confluence URL).
      // It carries only attrs.url — render it as an autolink so the URL is never lost.
      const u = cardUrl(node);
      return u ? '<' + u + '>' : '';
    }
    case 'mediaSingle':
    case 'mediaGroup':
      return '_(media omitted)_';
    default:
      // unknown block: try children, else inline text. Only an ARRAY is walkable — `content` as a
      // bare string used to throw (json-slim then handed the payload back intact), and iterating
      // it would render the node EMPTY, so it is read as the node's text.
      if (Array.isArray(node.content)) return renderMixed(node.content, depth, singleLine, '\n\n');
      if (typeof node.content === 'string') return renderText({ type: 'text', text: node.content }, true, singleLine);
      return textOf(node);
  }
}

// Convert an ADF doc — or any wrapper object that contains one — to Markdown.
// Returns null when no ADF doc node is present. This is the single home of the
// converter: json-slim.cjs require()s it for the ADF-detection compression stage,
// and the CLI below is the same call over stdin/a file.
function adfToMarkdown(input) {
  const doc = findDoc(input);
  if (!doc) return null;
  // a block never ends in whitespace: a trailing space that a mark pushed outside its
  // delimiters (`~~x~~ `), or a trailing hard break, is dropped on the way back — which
  // would break the round trip
  return trimAscii((doc.content || []).map((b) => renderBlock(b).replace(/[ \t\n]+$/, ''))
    .join('\n\n').replace(/\n{3,}/g, '\n\n'));
}

module.exports = { adfToMarkdown, findDoc, renderBlock, inline, renderText, cardUrl };

if (require.main === module) {
  const md = adfToMarkdown(readJSON());
  if (md == null) { process.stderr.write('adf-to-md: no ADF doc node found in input\n'); process.exit(1); }
  process.stdout.write(md + '\n');
}
