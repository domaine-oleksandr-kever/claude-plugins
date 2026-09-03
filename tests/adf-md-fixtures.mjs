#!/usr/bin/env node
// Fixture suite for the two ADF converters (plugins/fnd/scripts/{adf-to-md,md-to-adf}.cjs).
// Encodes the DESIRED behavior: run it after any converter change. Cases named `bug-*` are
// the 2026-07 audit findings; the rest pin behavior that was already correct.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const A2M = path.join(ROOT, 'plugins/fnd/scripts/adf-to-md.cjs');
const M2A = path.join(ROOT, 'plugins/fnd/scripts/md-to-adf.cjs');

const run = (script, input, args = []) =>
  execFileSync('node', [script, ...args], { input, encoding: 'utf8' });

const doc = (content) => ({ type: 'doc', version: 1, content });
const p = (content) => ({ type: 'paragraph', content });
const t = (text, marks) => (marks ? { type: 'text', text, marks } : { type: 'text', text });
const li = (content) => ({ type: 'listItem', content });
const ul = (content) => ({ type: 'bulletList', content });
const ol = (content, attrs) => (attrs ? { type: 'orderedList', attrs, content } : { type: 'orderedList', content });
const hb = { type: 'hardBreak' };
const quote = (content) => ({ type: 'blockquote', content });
const cb = (text, language) => (language
  ? { type: 'codeBlock', attrs: { language }, content: [t(text)] }
  : { type: 'codeBlock', content: [t(text)] });
const tbl = (rows) => ({ type: 'table', content: rows });
const trow = (cells) => ({ type: 'tableRow', content: cells });
const th = (content) => ({ type: 'tableHeader', content });
const td = (content) => ({ type: 'tableCell', content });
// U+00A0: JS \s matches it, so every trim in the converters has to be ASCII-only, or the
// NBSP the Jira editor inserts is silently deleted at a block or mark boundary.
const NB = '\u00a0';

let pass = 0, fail = 0;
const failures = [];
// key-order-independent object comparison
const canon = (v) => Array.isArray(v) ? v.map(canon)
  : (v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]))
    : v);
function check(name, actual, expected) {
  const a = typeof actual === 'string' ? actual.trimEnd() : JSON.stringify(canon(actual));
  const e = typeof expected === 'string' ? expected.trimEnd() : JSON.stringify(canon(expected));
  if (a === e) { pass++; } else {
    fail++;
    failures.push(`[${name}]\n  expected: ${JSON.stringify(e)}\n  actual:   ${JSON.stringify(a)}`);
  }
}
const a2m = (adf, args) => run(A2M, JSON.stringify(adf), args);
const m2a = (md, args) => JSON.parse(run(M2A, md, args));

// ---------------------------------------------------------------- adf-to-md --

// bug-1: nested bullet list — children on their own indented lines, not space-joined
const nestedUl = doc([
  ul([
    li([p([t('Parent')]), ul([li([p([t('Child 1')])]), li([p([t('Child 2')])])])]),
    li([p([t('Sibling')])]),
  ]),
]);
check('bug-a2m-nested-bullets', a2m(nestedUl), '- Parent\n  - Child 1\n  - Child 2\n- Sibling');

// bug-1b: ordered list with nested bullets (the AC shape Jira tickets actually use)
const nestedOl = doc([
  ol([
    li([p([t('AC 1')]), ul([li([p([t('sub a')])]), li([p([t('sub b')])])])]),
    li([p([t('AC 2')])]),
  ]),
]);
check('bug-a2m-nested-ol-ul', a2m(nestedOl), '1. AC 1\n  - sub a\n  - sub b\n2. AC 2');

// bug-1c: double nesting keeps increasing indentation
const deepUl = doc([
  ul([li([p([t('L1')]), ul([li([p([t('L2')]), ul([li([p([t('L3')])])])])])])]),
]);
check('bug-a2m-double-nested', a2m(deepUl), '- L1\n  - L2\n    - L3');

// bug-2: inline status (lozenge) and date nodes must not vanish
const statusDate = doc([
  p([
    t('State: '),
    { type: 'status', attrs: { text: 'IN PROGRESS', color: 'blue' } },
    t(' due '),
    { type: 'date', attrs: { timestamp: '1767139200000' } },
  ]),
]);
check('bug-a2m-status-date', a2m(statusDate), 'State: [IN PROGRESS] due 2025-12-31');

// bug-3: code+link marks — the link must survive around the code span
const codeLink = doc([
  p([t('see '), t('config.js', [{ type: 'code' }, { type: 'link', attrs: { href: 'https://x.test/f' } }])]),
]);
check('bug-a2m-code-link', a2m(codeLink), 'see [`config.js`](https://x.test/f)');

// bug-4: pipes inside table cells must be escaped (2 columns stay 2 columns)
const pipeTable = doc([{
  type: 'table',
  content: [
    { type: 'tableRow', content: [
      { type: 'tableHeader', content: [p([t('Key')])] },
      { type: 'tableHeader', content: [p([t('Value')])] },
    ] },
    { type: 'tableRow', content: [
      { type: 'tableCell', content: [p([t('mode')])] },
      { type: 'tableCell', content: [p([t('a|b')])] },
    ] },
  ],
}]);
check('bug-a2m-table-pipe', a2m(pipeTable), '| Key | Value |\n| --- | --- |\n| mode | a\\|b |');

// regressions: marks, cards, heading clamp, code block, quote, rule, media, flat list
const marks = doc([
  p([
    t('bold', [{ type: 'strong' }]), t(' '), t('em', [{ type: 'em' }]), t(' '),
    t('gone', [{ type: 'strike' }]), t(' '), t('x', [{ type: 'link', attrs: { href: 'https://l.test' } }]),
  ]),
]);
check('a2m-marks', a2m(marks), '**bold** *em* ~~gone~~ [x](https://l.test)');
check('a2m-heading-clamp', a2m(doc([{ type: 'heading', attrs: { level: 8 }, content: [t('H')] }])), '###### H');
check('a2m-inline-card', a2m(doc([p([t('doc: '), { type: 'inlineCard', attrs: { url: 'https://n.test/p' } }])])), 'doc: <https://n.test/p>');
check('a2m-codeblock', a2m(doc([{ type: 'codeBlock', attrs: { language: 'js' }, content: [t('a();\nb();')] }])), '```js\na();\nb();\n```');
check('a2m-quote-rule', a2m(doc([{ type: 'blockquote', content: [p([t('q')])] }, { type: 'rule' }])), '> q\n\n---');
check('a2m-media', a2m(doc([{ type: 'mediaSingle', content: [] }])), '_(media omitted)_');
check('a2m-flat-list', a2m(doc([ul([li([p([t('one')])]), li([p([t('two')])])])])), '- one\n- two');

// regression: a list inside a table cell flattens onto the cell's single line
const listCell = doc([{
  type: 'table',
  content: [
    { type: 'tableRow', content: [{ type: 'tableHeader', content: [p([t('H')])] }] },
    { type: 'tableRow', content: [{ type: 'tableCell', content: [ul([li([p([t('x')])]), li([p([t('y')])])])] }] },
  ],
}]);
check('a2m-table-list-cell', a2m(listCell), '| H |\n| --- |\n| - x - y |');

// ---------------------------------------------------------------- md-to-adf --

// bug-5: info strings like ```c++ must open a fence (language = first word)
check('bug-m2a-fence-infostring', m2a('```c++\nint x;\n```\nafter'), doc([
  { type: 'codeBlock', content: [{ type: 'text', text: 'int x;' }], attrs: { language: 'c++' } },
  p([t('after')]),
]));
check('m2a-fence-plain', m2a('```\nx\n```'), doc([
  { type: 'codeBlock', content: [{ type: 'text', text: 'x' }] },
]));

// bug-6: * emphasis needs non-space flanks — formulas survive
check('bug-m2a-em-flanking', m2a('Compute a * b * c'), doc([p([t('Compute a * b * c')])]));
check('m2a-em-real', m2a('a *real* one'), doc([p([t('a '), t('real', [{ type: 'em' }]), t(' one')])]));
check('bug-m2a-strong-flanking', m2a('2 ** 3 ** 4'), doc([p([t('2 ** 3 ** 4')])]));
// an opener a later one shadows is literal — CommonMark pairs a closer with the NEAREST opener,
// so the intraword `**` of `2**3` must not steal the closer of the real one
check('bug-m2a-em-shadowed-opener', m2a('2**3 is 8 and **bold** text'), doc([
  p([t('2**3 is 8 and '), t('bold', [{ type: 'strong' }]), t(' text')]),
]));
check('bug-m2a-strike-shadowed-opener', m2a('2~~3 and ~~gone~~'), doc([
  p([t('2~~3 and '), t('gone', [{ type: 'strike' }])]),
]));
// an intraword run that nothing shadows still marks, the way CommonMark reads it — adf-to-md
// emits exactly this shape for an unmarked node followed by a marked one
check('m2a-em-intraword', m2a('use**bold**'), doc([
  p([t('use'), t('bold', [{ type: 'strong' }])]),
]));

// bug-7: nested lists must nest inside the previous listItem, not flatten
check('bug-m2a-nested-lists', m2a('1. Parent\n   - sub a\n   - sub b\n2. Second'), doc([
  ol([
    li([p([t('Parent')]), ul([li([p([t('sub a')])]), li([p([t('sub b')])])])]),
    li([p([t('Second')])]),
  ]),
]));
check('bug-m2a-double-nested', m2a('- L1\n  - L2\n    - L3\n- L1b'), doc([
  ul([
    li([p([t('L1')]), ul([li([p([t('L2')]), ul([li([p([t('L3')])])])])])]),
    li([p([t('L1b')])]),
  ]),
]));
check('m2a-flat-ol-start', m2a('3. three\n4. four'), doc([
  ol([li([p([t('three')])]), li([p([t('four')])])], { order: 3 }),
]));
check('m2a-flat-ul', m2a('- a\n- b'), doc([ul([li([p([t('a')])]), li([p([t('b')])])])]));

// regression: snake_case survives, links/code/strike/bold work
check('m2a-inline', m2a('see `customfield_10038` and [d](https://d.test) ~~old~~ **b**'), doc([
  p([
    t('see '), t('customfield_10038', [{ type: 'code' }]), t(' and '),
    t('d', [{ type: 'link', attrs: { href: 'https://d.test' } }]),
    t(' '), t('old', [{ type: 'strike' }]), t(' '), t('b', [{ type: 'strong' }]),
  ]),
]));

// regression: tables in both modes
check('m2a-table', m2a('| A | B |\n| --- | --- |\n| 1 | 2 |'), doc([{
  type: 'table',
  content: [
    { type: 'tableRow', content: [
      { type: 'tableHeader', content: [p([t('A')])] },
      { type: 'tableHeader', content: [p([t('B')])] },
    ] },
    { type: 'tableRow', content: [
      { type: 'tableCell', content: [p([t('1')])] },
      { type: 'tableCell', content: [p([t('2')])] },
    ] },
  ],
}]));
check('m2a-table-notables', m2a('| A | B |\n| --- | --- |\n| 1 | 2 |', ['--no-tables']), doc([
  ul([li([p([t('A: 1 · B: 2')])])]),
]));

// regression: heading, blockquote, rule
check('m2a-blocks', m2a('# H1\n\n> quoted\n\n---'), doc([
  { type: 'heading', attrs: { level: 1 }, content: [t('H1')] },
  { type: 'blockquote', content: [p([t('quoted')])] },
  { type: 'rule' },
]));

// mentions and emoji render as their display text, never vanish
check('a2m-mention-emoji', a2m(doc([p([
  t('ping '),
  { type: 'mention', attrs: { id: '5b10a', text: '@Oleksandr' } },
  t(' '),
  { type: 'emoji', attrs: { shortName: ':tada:' } },
])])), 'ping @Oleksandr :tada:');

// unknown block node (panel) degrades to its children — text survives, chrome is lost
check('a2m-unknown-panel', a2m(doc([
  { type: 'panel', attrs: { panelType: 'info' }, content: [p([t('heads-up text')])] },
])), 'heads-up text');

// blockCard at block level with a JSON-LD payload — URL comes from attrs.data['@id']
check('a2m-blockcard-jsonld', a2m(doc([
  { type: 'blockCard', attrs: { data: { '@id': 'https://c.test/page' } } },
])), '<https://c.test/page>');

// --field extracts one field's ADF from a full getJiraIssue envelope (stdin)
check('a2m-field-extract', run(A2M, JSON.stringify({
  key: 'ELC-61',
  fields: { summary: 'S', customfield_10038: doc([p([t('the approach')])]) },
}), ['--field', 'customfield_10038']), 'the approach');

// --field on a plain-string field passes the string through untouched
check('a2m-field-string', run(A2M, JSON.stringify({
  fields: { customfield_10040: 'already markdown' },
}), ['--field', 'customfield_10040']), 'already markdown');

// ***bold-italic*** → strong + em on one text node
check('m2a-strongem', m2a('a ***hot*** path'), doc([
  p([t('a '), t('hot', [{ type: 'strong' }, { type: 'em' }]), t(' path')]),
]));

// round-trip: a nested-list AC survives md → adf → md
check('roundtrip-nested', run(A2M, JSON.stringify(m2a('1. AC 1\n  - sub a\n  - sub b\n2. AC 2'))),
  '1. AC 1\n  - sub a\n  - sub b\n2. AC 2');

// ------------------------------------------------- bug-8: nested inline marks --

const mStrong = { type: 'strong' };
const mEm = { type: 'em' };
const mStrike = { type: 'strike' };
const mCode = { type: 'code' };
const mLink = (href) => ({ type: 'link', attrs: { href } });

// a code span inside bold keeps the code mark (ADF forbids strong on code, so the
// incompatible outer mark is dropped — never leaked back as literal backticks)
check('bug-m2a-strong-code', m2a('**bold `code`**'), doc([
  p([t('bold ', [mStrong]), t('code', [mCode])]),
]));
check('bug-m2a-strong-link', m2a('**[link](https://x.dev)**'), doc([
  p([t('link', [mStrong, mLink('https://x.dev')])]),
]));
check('bug-m2a-strong-nested-em', m2a('**bold *it* tail**'), doc([
  p([t('bold ', [mStrong]), t('it', [mStrong, mEm]), t(' tail', [mStrong])]),
]));
check('bug-m2a-link-nested-code', m2a('see [`config.js`](https://x.test/f)'), doc([
  p([t('see '), t('config.js', [mLink('https://x.test/f'), mCode])]),
]));
// emit must never silently drop a mark: strong wraps OUTSIDE the code span
check('bug-a2m-code-strong', a2m(doc([p([t('x', [mCode, mStrong])])])), '**`x`**');
// emphasis delimiters can't hug whitespace — the space moves outside the marks
check('bug-a2m-mark-trailing-space', a2m(doc([p([t('bold ', [mStrong]), t('code', [mCode])])])),
  '**bold** `code`');

// ------------------------------------------------ bug-9: table pipe symmetry --

const pipeCells = doc([tbl([
  trow([th([p([t('Col')])]), th([p([t('Other')])])]),
  trow([td([p([t('a|b')])]), td([p([t('z')])])]),
])]);
check('bug-m2a-table-escaped-pipe', m2a('| Col | Other |\n| --- | --- |\n| a\\|b | z |'), pipeCells);
check('bug-roundtrip-table-pipe', m2a(a2m(pipeTable)), pipeTable);
// a pipe inside a code span is cell text — neither side escapes it
const codePipeCell = doc([tbl([
  trow([th([p([t('H')])])]),
  trow([td([p([t('a|b', [mCode])])])]),
])]);
check('bug-m2a-table-code-pipe', m2a('| H |\n| --- |\n| `a|b` |'), codePipeCell);
check('bug-a2m-table-code-pipe', a2m(codePipeCell), '| H |\n| --- |\n| `a|b` |');

// --------------------------------------------- bug-10: fenced block ``` inside --

const innerFence = doc([
  { type: 'codeBlock', attrs: { language: 'md' }, content: [t('a\n```\nb')] },
  p([t('after')]),
]);
check('bug-a2m-codeblock-inner-fence', a2m(innerFence), '````md\na\n```\nb\n````\n\nafter');
check('bug-m2a-fence-long', m2a('````md\na\n```\nb\n````\n\nafter'), innerFence);
check('bug-roundtrip-inner-fence', m2a(a2m(innerFence)), innerFence);
check('bug-a2m-codeblock-only-fence', a2m(doc([{ type: 'codeBlock', content: [t('```')] }])),
  '````\n```\n````');
// a triple-backtick code SPAN is not a fence (an info string can't contain backticks)
check('bug-m2a-inline-code-not-fence', m2a('```x``` is a span'), doc([
  p([t('x', [mCode]), t(' is a span')]),
]));

// ------------------------------------------ bug-11: link / code-span scan edges --

check('bug-m2a-link-paren-href', m2a('[docs](https://x.dev/a(b)c)'), doc([
  p([t('docs', [mLink('https://x.dev/a(b)c')])]),
]));
check('bug-m2a-link-wiki-paren', m2a('see [x](https://en.wikipedia.org/wiki/Foo_(bar))!'), doc([
  p([t('see '), t('x', [mLink('https://en.wikipedia.org/wiki/Foo_(bar)')]), t('!')]),
]));
check('bug-m2a-link-bracket-label', m2a('[a [b] c](https://x.dev)'), doc([
  p([t('a [b] c', [mLink('https://x.dev')])]),
]));
check('bug-m2a-code-double-tick', m2a('``code with ` tick``'), doc([
  p([t('code with ` tick', [mCode])]),
]));
check('bug-a2m-code-inner-tick', a2m(doc([p([t('a`b', [mCode])])])), '``a`b``');
// code content that starts/ends with a space (or a backtick) needs the padding space
// CommonMark strips back off — without it the spaces are lost on the way back
const codeSpaces = doc([p([t(' x ', [mCode])])]);
check('bug-a2m-code-pad-space', a2m(codeSpaces), '`  x  `');
check('bug-roundtrip-code-pad-space', m2a(a2m(codeSpaces)), codeSpaces);
// a pipe in an href gets escaped by the table cell, so the href must be UNescaped on read
const cellLink = doc([tbl([
  trow([th([p([t('H')])])]),
  trow([td([p([t('a|b', [mLink('https://x.dev/?a=1|2')])])])]),
])]);
check('bug-a2m-cell-link-pipe', a2m(cellLink), '| H |\n| --- |\n| [a\\|b](https://x.dev/?a=1\\|2) |');
check('bug-roundtrip-cell-link-pipe', m2a(a2m(cellLink)), cellLink);
const parenHref = doc([p([t('d', [mLink('https://x.dev/a(b)')])])]);
check('bug-roundtrip-link-paren', m2a(a2m(parenHref)), parenHref);
// an unbalanced paren (or whitespace) in the href needs the <...> target form
const oddHref = doc([p([t('d', [mLink('https://x.dev/a)b')])])]);
check('bug-a2m-link-unbalanced-paren', a2m(oddHref), '[d](<https://x.dev/a)b>)');
check('bug-roundtrip-link-unbalanced', m2a(a2m(oddHref)), oddHref);
check('m2a-link-query', m2a('[q](https://x.dev/?a=1&b=2)'), doc([
  p([t('q', [mLink('https://x.dev/?a=1&b=2')])]),
]));

// --------------------------- bug-12: literal structure text + hard line breaks --

const prose = doc([
  p([t('# not a heading')]),
  p([t('- not a list')]),
  p([t('1. not ordered')]),
  p([t('> not a quote')]),
  p([t('```not a fence')]),
  p([t('---')]),
]);
check('bug-a2m-escape-structure', a2m(prose),
  '\\# not a heading\n\n\\- not a list\n\n1\\. not ordered\n\n\\> not a quote\n\n\\`\\`\\`not a fence\n\n\\---');
check('bug-roundtrip-escape-structure', m2a(a2m(prose)), prose);
// a literal backtick is escaped wherever it appears: unescaped it would open a code span
// and swallow the nodes up to the next one
const strayTicks = doc([p([t('use ` here'), t('x', [mLink('https://x.dev')]), t(' and ` there')])]);
check('bug-a2m-escape-literal-backtick', a2m(strayTicks),
  'use \\` here[x](https://x.dev) and \\` there');
check('bug-roundtrip-escape-literal-backtick', m2a(a2m(strayTicks)), strayTicks);
// a list item / cell whose own text starts with a marker is escaped the same way
check('bug-a2m-escape-in-listitem', a2m(doc([ul([li([p([t('- literal')])])])])), '- \\- literal');
check('bug-roundtrip-escape-in-listitem', m2a(a2m(doc([ul([li([p([t('- literal')])])])]))),
  doc([ul([li([p([t('- literal')])])])]));

const hardBreak = doc([p([t('line one'), hb, t('line two')])]);
check('bug-a2m-hardbreak', a2m(hardBreak), 'line one  \nline two');
check('bug-m2a-hardbreak', m2a('line one  \nline two'), hardBreak);
check('bug-m2a-hardbreak-backslash', m2a('line one\\\nline two'), hardBreak);
check('bug-roundtrip-hardbreak', m2a(a2m(hardBreak)), hardBreak);
// a soft wrap is still just a space — only two trailing spaces mean a break
check('m2a-softwrap-join', m2a('line one\nline two'), doc([p([t('line one line two')])]));
// a hardBreak inside a LIST ITEM degrades to a space: a real break would end the list and
// spill the rest of the item out as a top-level paragraph
check('a2m-hardbreak-in-listitem', a2m(doc([ul([li([p([t('a'), hb, t('b')])])])])),
  '- a b');
check('a2m-hardbreak-in-quote', a2m(doc([quote([p([t('a'), hb, t('b')])])])),
  '> a  \n> b');
// a block never ends in whitespace — a trailing break would just be dropped on the way back
check('a2m-trailing-hardbreak', a2m(doc([p([t('a'), hb]), p([t('b')])])), 'a\n\nb');

// -------------------------------------------- bug-13: empty content array shape --

check('bug-m2a-empty-heading', m2a('# '), doc([{ type: 'heading', attrs: { level: 1 } }]));
check('bug-m2a-bare-hash-heading', m2a('#'), doc([{ type: 'heading', attrs: { level: 1 } }]));
check('bug-m2a-empty-heading-then-para', m2a('## \n\ntext'), doc([
  { type: 'heading', attrs: { level: 2 } }, p([t('text')]),
]));
check('bug-m2a-empty-codeblock', m2a('```\n```'), doc([{ type: 'codeBlock' }]));
const emptyHeading = doc([{ type: 'heading', attrs: { level: 1 } }, p([t('x')])]);
check('bug-a2m-empty-heading', a2m(emptyHeading), '#\n\nx');
check('bug-roundtrip-empty-heading', m2a(a2m(emptyHeading)), emptyHeading);

// ---------------------------------------- bug-14: literal backslash at a node edge --

// the renderer appends its own delimiter directly after a text node, so a backslash sitting at
// the node's END must be doubled too — otherwise it escapes that delimiter and the mark is lost
check('bug-a2m-trailing-backslash-code', a2m(doc([p([t('a\\'), t('b', [mCode])])])), 'a\\\\`b`');
check('bug-a2m-trailing-backslash-strong', a2m(doc([p([t('a\\', [mStrong])])])), '**a\\\\**');
for (const [label, adf] of [
  ['code', doc([p([t('a\\'), t('b', [mCode])])])],
  ['link', doc([p([t('a\\'), t('b', [mLink('https://x.dev')])])])],
  ['strike', doc([p([t('a\\'), t('b', [mStrike])])])],
  ['strong-self', doc([p([t('a\\', [mStrong])])])],
  ['link-self', doc([p([t('a\\', [mLink('https://x.dev')])])])],
  ['cell', doc([tbl([trow([th([p([t('H')])])]), trow([td([p([t('a\\', [mStrong])])])])])])],
]) check(`bug-roundtrip-trailing-backslash-${label}`, m2a(a2m(adf)), adf);

// ------------------------------ bug-15: a pipeless GFM table directly under prose --

// a table OPENER (a pipe row followed by a separator row) ends the paragraph even without
// leading pipes; a lone pipe in a wrapped prose line does not, or the line's hard break dies
check('bug-m2a-pipeless-table-under-prose', m2a('Intro text\nA | B\n--- | ---\n1 | 2'), doc([
  p([t('Intro text')]),
  tbl([
    trow([th([p([t('A')])]), th([p([t('B')])])]),
    trow([td([p([t('1')])]), td([p([t('2')])])]),
  ]),
]));
check('bug-m2a-pipeless-table-notables', m2a('Fields:\nName | Type\n--- | ---\nsku | text', ['--no-tables']), doc([
  p([t('Fields:')]),
  ul([li([p([t('Name: sku · Type: text')])])]),
]));
check('m2a-prose-pipe-stays-in-paragraph', m2a('a wrapped line\nwith a | pipe in it'),
  doc([p([t('a wrapped line with a | pipe in it')])]));
check('m2a-leading-pipe-table-under-prose', m2a('Intro\n| A |\n| --- |\n| 1 |'), doc([
  p([t('Intro')]),
  tbl([trow([th([p([t('A')])])]), trow([td([p([t('1')])])])]),
]));

// -------------------------------------------- bug-16: a codeBlock inside a listItem --

// markdown has no fence a list item can carry that md-to-adf reads back, so it degrades to an
// inline code span — a leaked fence never closes and swallows the rest of the document
const liCode = doc([ul([li([p([t('run the migration')]), cb('bin/rake db:migrate', 'sh')])]), p([t('after')])]);
check('bug-a2m-listitem-codeblock', a2m(liCode), '- run the migration `bin/rake db:migrate`\n\nafter');
check('bug-roundtrip-listitem-codeblock', m2a(a2m(liCode)), doc([
  ul([li([p([t('run the migration '), t('bin/rake db:migrate', [mCode])])])]),
  p([t('after')]),
]));
check('bug-a2m-listitem-codeblock-multiline',
  a2m(doc([ul([li([p([t('run')]), cb('a\nb')])])])), '- run `a b`');
// an EMPTY code block has no code span form (`` is an unclosed run, not an empty span), so it
// is dropped rather than emitted as something md-to-adf reads back as literal backticks
check('a2m-listitem-empty-codeblock', a2m(doc([ul([li([p([t('x')]), cb('')])])])), '- x');
// a listItem child markdown cannot nest either flattens into the item line or stays a child
// list — nothing may escape the item and become a block of its own
check('a2m-listitem-foreign-block',
  a2m(doc([ul([li([p([t('note')]), tbl([trow([th([p([t('H')])])]), trow([td([p([t('v')])])])])])]), p([t('after')])])),
  '- note | H | | --- | | v |\n\nafter');

// ------------------------------- bug-17: a blockquote holding more than one paragraph --

// md-to-adf re-enters BLOCK parsing on the de-prefixed lines, and sibling blocks are separated
// by a bare `>` line so the paragraph boundary survives the round trip
check('bug-a2m-quote-two-paras', a2m(doc([quote([p([t('a')]), p([t('b')])])])), '> a\n>\n> b');
check('bug-m2a-quote-two-paras', m2a('> a\n>\n> b'), doc([quote([p([t('a')]), p([t('b')])])]));
for (const [label, q] of [
  ['codeblock', quote([p([t('From the ticket:')]), cb('theme check --fail-level error')])],
  ['codeblock-only', quote([cb('a\nb')])],
  ['two-paras', quote([p([t('a')]), p([t('b')])])],
  ['list', quote([ul([li([p([t('x')])]), li([p([t('y')])])])])],
]) check(`bug-roundtrip-quote-${label}`, m2a(a2m(doc([q]))), doc([q]));

// ADF's blockquote admits only these child types. Jira rejects the WHOLE document over one
// foreign node, so a quoted heading/rule/table/nested quote degrades to paragraph text — the
// content survives, the write does not fail.
const QUOTE_OK = ['paragraph', 'bulletList', 'orderedList', 'codeBlock', 'mediaGroup', 'mediaSingle', 'extension'];
for (const [label, md, degraded] of [
  ['heading', '> ## Note', quote([p([t('## Note')])])],
  ['rule', '> a\n>\n> ---', quote([p([t('a')]), p([t('---')])])],
  ['table', '> | H |\n> | --- |\n> | v |', quote([p([t('| H | | --- | | v |')])])],
  ['nested', '> > deep', quote([p([t('> deep')])])],
  ['marker-run', '>'.repeat(16), quote([p([t('>'.repeat(15))])])],
]) {
  const adf = m2a(md);
  check(`bug-m2a-quote-degrade-${label}`, adf, doc([degraded]));
  check(`bug-m2a-quote-content-model-${label}`,
    (adf.content[0].content || []).map((b) => b.type).filter((ty) => !QUOTE_OK.includes(ty)), []);
  // the degraded shape must be a FIXPOINT, or every read-edit-write mangles it further
  check(`bug-roundtrip-quote-degrade-${label}`, m2a(a2m(doc([degraded]))), doc([degraded]));
}

// ------------------------------------- bug-18: a smart-link card comes back as a link --

// adf-to-md emits inlineCard/blockCard as an autolink; with no autolink rule on the read side
// the URL would land in Jira as inert prose, so a card normalizes to a `link` mark
check('bug-m2a-autolink', m2a('doc: <https://n.test/p>'), doc([
  p([t('doc: '), t('https://n.test/p', [mLink('https://n.test/p')])]),
]));
check('bug-roundtrip-inlinecard-to-link',
  m2a(a2m(doc([p([t('doc: '), { type: 'inlineCard', attrs: { url: 'https://n.test/p' } }])]))),
  doc([p([t('doc: '), t('https://n.test/p', [mLink('https://n.test/p')])])]));
check('bug-roundtrip-blockcard-to-link',
  m2a(a2m(doc([{ type: 'blockCard', attrs: { url: 'https://n.test/p' } }]))),
  doc([p([t('https://n.test/p', [mLink('https://n.test/p')])])]));
// a link whose text IS its href comes back out as an autolink, not as [u](u)
check('bug-a2m-link-text-is-href',
  a2m(doc([p([t('https://n.test/p', [mLink('https://n.test/p')])])])), '<https://n.test/p>');
// angle brackets that are not an autolink stay literal
check('m2a-angle-not-autolink', m2a('a <div> tag'), doc([p([t('a <div> tag')])]));
check('m2a-autolink-mailto', m2a('<mailto:a@b.test>'), doc([
  p([t('mailto:a@b.test', [mLink('mailto:a@b.test')])]),
]));

// ---------------------------- bug-20: a bare URL in prose lands in Jira as inert text --

// the GFM autolink form — what a developer pastes — must carry a `link` mark (2026-09-03 report)
const previewUrl = 'https://example.myshopify.com/?_ab=0&_fd=0&preview_theme_id=150838182070';
check('bug-m2a-bare-url', m2a('Bare: ' + previewUrl), doc([
  p([t('Bare: '), t(previewUrl, [mLink(previewUrl)])]),
]));
// sentence punctuation after the URL is prose; a `)` closes the URL only when nothing inside
// the URL opened it
check('bug-m2a-bare-url-punct',
  m2a('See https://x.dev/a. Then https://x.dev/b, or (https://x.dev/c) and https://en.wikipedia.org/wiki/Foo_(bar) end'),
  doc([p([
    t('See '), t('https://x.dev/a', [mLink('https://x.dev/a')]),
    t('. Then '), t('https://x.dev/b', [mLink('https://x.dev/b')]),
    t(', or ('), t('https://x.dev/c', [mLink('https://x.dev/c')]),
    t(') and '), t('https://en.wikipedia.org/wiki/Foo_(bar)', [mLink('https://en.wikipedia.org/wiki/Foo_(bar)')]),
    t(' end'),
  ])]));
check('bug-m2a-bare-url-quoted', m2a('"https://q.dev" and mailto:a@b.co;'), doc([
  p([t('"'), t('https://q.dev', [mLink('https://q.dev')]), t('" and '), t('mailto:a@b.co', [mLink('mailto:a@b.co')]), t(';')]),
]));
// only well-known schemes, only at a word start, never a bare scheme, never inside a code span
check('bug-m2a-bare-url-not', m2a('foo:bar https:// x word-https://x.dev `https://c.dev`'), doc([
  p([t('foo:bar https:// x word-https://x.dev '), t('https://c.dev', [mCode])]),
]));
// an escape inside the run is consumed like anywhere else in prose (the Atlassian MCP's own
// markdown writer escapes query-string underscores that way)
check('bug-m2a-bare-url-escaped', m2a('https://x.dev/?\\_ab=0&\\_fd=1'), doc([
  p([t('https://x.dev/?_ab=0&_fd=1', [mLink('https://x.dev/?_ab=0&_fd=1')])]),
]));
// inside a label the explicit target wins; inside a mark the mark is kept
check('bug-m2a-bare-url-in-label', m2a('[https://a.test](https://b.test)'), doc([
  p([t('https://a.test', [mLink('https://b.test')])]),
]));
check('bug-m2a-bare-url-in-strong', m2a('**see https://x.dev/b**'), doc([
  p([t('see ', [mStrong]), t('https://x.dev/b', [mStrong, mLink('https://x.dev/b')])]),
]));
// a plain-text URL stored in ADF (written by something that never linkified it) comes back
// LINKED after one read-edit-write cycle — the one deliberate non-identity of the pair — and
// is stable from then on
const plainUrl = doc([p([t('see https://n.test/p here')])]);
const linkedUrl = doc([p([t('see '), t('https://n.test/p', [mLink('https://n.test/p')]), t(' here')])]);
check('bug-roundtrip-plain-url-promoted', m2a(a2m(plainUrl)), linkedUrl);
check('bug-roundtrip-plain-url-stable', m2a(a2m(linkedUrl)), linkedUrl);

// ------------------------------------------ bug-19: a code span of nothing but spaces --

// CommonMark only strips the padding space when the content is not all whitespace, so padding
// all-space content adds two spaces per cycle and never converges
const codeAllSpace = doc([p([t('   ', [mCode])])]);
check('bug-a2m-code-all-space', a2m(codeAllSpace), '`   `');
check('bug-roundtrip-code-all-space', m2a(a2m(codeAllSpace)), codeAllSpace);

// --------------------------------- bug-20: a hardBreak in a heading or a table cell --

// an ATX heading and a table cell are single-LINE constructs: a real break ends the block and
// demotes the rest, so it degrades to a space the way a list item's already does
const hbHeading = doc([{ type: 'heading', attrs: { level: 2 }, content: [t('a'), hb, t('b')] }]);
check('bug-a2m-hardbreak-in-heading', a2m(hbHeading), '## a b');
check('bug-roundtrip-hardbreak-in-heading', m2a(a2m(hbHeading)),
  doc([{ type: 'heading', attrs: { level: 2 }, content: [t('a b')] }]));
check('bug-a2m-hardbreak-in-cell',
  a2m(doc([tbl([trow([th([p([t('H')])])]), trow([td([p([t('a'), hb, t('b')])])])])])),
  '| H |\n| --- |\n| a b |');

// ------------------------------------------------- bug-21: two hardBreaks in a row --

// the second break starts an EMPTY line, and two trailing spaces there is a whitespace-only
// line — which ends the paragraph. A backslash break keeps that line non-blank.
const hbDouble = doc([p([t('a'), hb, hb, t('b')])]);
check('bug-a2m-hardbreak-double', a2m(hbDouble), 'a  \n\\\nb');
check('bug-roundtrip-hardbreak-double', m2a(a2m(hbDouble)), hbDouble);

// --------------------------------------- bug-22: a paragraph line that starts with `|` --

// isBlockStart reads a leading pipe as a table row, so literal pipe prose has to be escaped or
// the paragraph is promoted to a table and its hard breaks are destroyed
check('bug-a2m-escape-leading-pipe', a2m(doc([p([t('|a|b|')])])), '\\|a|b|');
const pipeProse = doc([p([t('|a|b|'), hb, t('|---|---|'), hb, t('|1|2|')])]);
check('bug-a2m-pipe-prose', a2m(pipeProse), '\\|a|b|  \n\\|---|---|  \n\\|1|2|');
check('bug-roundtrip-pipe-prose', m2a(a2m(pipeProse)), pipeProse);
const hbPipe = doc([p([t('a'), hb, t('|b|')])]);
check('bug-roundtrip-hardbreak-pipe', m2a(a2m(hbPipe)), hbPipe);

// ----------------------------------------- bug-23: a non-breaking space at a boundary --

const nbspStrong = doc([p([t(NB + 'a' + NB, [mStrong])])]);
for (const [label, adf] of [
  ['trailing', doc([p([t('a' + NB)])])],
  ['leading', doc([p([t(NB + 'a')])])],
  ['own-paragraph', doc([p([t(NB)]), p([t('b')])])],
  ['inside-strong', nbspStrong],
  ['cell', doc([tbl([trow([th([p([t('H')])])]), trow([td([p([t('a' + NB)])])])])])],
]) check(`bug-roundtrip-nbsp-${label}`, m2a(a2m(adf)), adf);

// ----------------------- bug-24: adjacent mark runs must not accumulate delimiters --

// an opening run is matched by a closer of the SAME length and both are consumed whole, so a
// surplus delimiter can never be left behind to become literal text in the stored field
check('bug-m2a-adjacent-strong-em-strong', m2a('**a***b***c**'), doc([
  p([t('a', [mStrong]), t('b', [mStrong, mEm]), t('c', [mStrong])]),
]));
check('bug-m2a-adjacent-em-strong-em', m2a('*a****b****c*'), doc([
  p([t('a', [mEm]), t('b', [mEm, mStrong]), t('c', [mEm])]),
]));
// four cycles: the markdown AND the stored ADF must both stop changing after the first pass
for (const seed of ['**a***b***c**', '*a****b****c*', '***a*****b**']) {
  const mds = [];
  const adfs = [];
  let md = seed;
  for (let k = 0; k < 4; k++) {
    const adf = m2a(md);
    md = a2m(adf).trimEnd();
    mds.push(md);
    adfs.push(JSON.stringify(canon(adf)));
  }
  check(`bug-cycle-md-stable[${seed}]`, mds.slice(1), [mds[1], mds[1], mds[1]]);
  check(`bug-cycle-adf-stable[${seed}]`, adfs.slice(1), [adfs[1], adfs[1], adfs[1]]);
}

// ---------------------------------------- bug-25: no invisible control byte in a source --

// a raw NUL makes grep/rg treat the whole file as binary and skip it silently, and it is
// indistinguishable from a space in a diff or an editor
const SCRIPT_DIR = path.join(ROOT, 'plugins/fnd/scripts');
const ctrlBytes = [];
for (const name of fs.readdirSync(SCRIPT_DIR).filter((n) => n.endsWith('.cjs')).sort()) {
  const buf = fs.readFileSync(path.join(SCRIPT_DIR, name));
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i];
    if ((c < 32 && c !== 9 && c !== 10 && c !== 13) || c === 127) {
      ctrlBytes.push(`${name}@${i}=0x${c.toString(16)}`);
      break;
    }
  }
}
check('bug-source-no-control-bytes', ctrlBytes, []);

// --------------------------- bug-26: unmatched delimiters must not go quadratic --

// glob-heavy prose opens an emphasis run on every `*` that can never close, and `[a](u` opens a
// link that can never close: re-scanning the tail per opener is O(n²) on ordinary input
const timed = (input, args = []) => {
  const t0 = Date.now();
  execFileSync('node', [M2A, ...args], { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
  return Date.now() - t0;
};
// the bound is deliberately far above the measured cost (tens of ms) — it includes node startup,
// and a loaded machine must not be able to fail a correct converter. It catches the blow-up
// (quadratic scanning, a stack overflow), not a slow laptop.
const PERF_MS = 10000;
const fast = (ms) => (ms < PERF_MS ? 'fast' : `slow (${ms} ms)`);
const globMs = timed('*.liquid '.repeat(20000)); // ~180 KB
check('bug-perf-glob-prose', fast(globMs), 'fast');
const linkMs = timed('[a](u'.repeat(8000)); // ~40 KB
check('bug-perf-unclosed-link', fast(linkMs), 'fast');
// deeply NESTED links: the label recursion is one stack frame and one bracket-pair scan per
// level, so without a depth bound this overflows the stack and prints no ADF at all
const nestMs = timed('['.repeat(8000) + 'x' + '](u)'.repeat(8000)); // ~40 KB
check('bug-perf-nested-link', fast(nestMs), 'fast');

// ------------------- bug-27: which backslash escapes the write path consumes --

// CommonMark punctuation escapes are undone when reading AUTHORED markdown, so `\.` and `\[`
// lose their backslash there. What must hold is the ROUND TRIP: adf-to-md doubles a literal
// backslash standing in front of one of those markers, so stored ADF text survives unchanged.
check('m2a-unescape-commonmark', m2a('Match ^\\d+\\.\\d+$ in the handle.'),
  doc([p([t('Match ^\\d+.\\d+$ in the handle.')])]));
const regexProse = doc([p([t('Match ^\\d+\\.\\d+$ and \\[INFO\\] and C:\\Users\\_priv here')])]);
check('bug-roundtrip-literal-backslash-prose', m2a(a2m(regexProse)), regexProse);

// --------------------------------------- bug-28: a code span inside a link label --

// CommonMark resolves code spans before link brackets, so a bracket inside a code span is not
// a label bracket and must not unbalance the label scan
check('bug-m2a-link-label-code-bracket', m2a('[`a]b`](https://u.test)'), doc([
  p([t('a]b', [mLink('https://u.test'), mCode])]),
]));
check('bug-m2a-link-label-code-balanced-bracket', m2a('[`items[0]`](https://x.dev/d)'), doc([
  p([t('items[0]', [mLink('https://x.dev/d'), mCode])]),
]));

// ----------------------- bug-29: a newline inside a text node that is not the first --

// renderText already splits a multi-line text node and escapes each line, but only the block's
// FIRST plain node counted as line-start — json-slim feeds this converter unnormalized ADF.
// The newline is emitted as a hard BREAK: as a raw newline it is a soft break, so one
// read-edit-write cycle would flatten the two lines into one.
const midNewline = doc([p([t('x', [mStrong]), t('\n# h')])]);
check('bug-a2m-newline-mid-paragraph', a2m(midNewline), '**x**  \n\\# h');
check('bug-roundtrip-newline-mid-paragraph', m2a(a2m(midNewline)),
  doc([p([t('x', [mStrong]), hb, t('# h')])]));
// a newline in a text node that OPENS the block, and a blank line inside one (whose break has to
// take the backslash form or the block ends there)
check('bug-a2m-newline-multi', a2m(doc([p([t('one\ntwo\n\nthree')])])), 'one  \ntwo  \n\\\nthree');
check('bug-roundtrip-newline-multi', m2a(a2m(doc([p([t('one\ntwo\n\nthree')])]))),
  doc([p([t('one'), hb, t('two'), hb, hb, t('three')])]));
// a newline inside MARKED text degrades to a space instead: md-to-adf parses each
// break-separated segment on its own, so no mark can span a break — a real one loses the mark
for (const [label, marks, md] of [
  ['strong', [mStrong], '**a # h**'],
  ['code', [mCode], '`a # h`'],
  ['strike', [mStrike], '~~a # h~~'],
]) {
  check(`bug-a2m-marked-multiline-${label}`, a2m(doc([p([t('a\n# h', marks)])])), md);
  check(`bug-roundtrip-marked-multiline-${label}`, m2a(a2m(doc([p([t('a\n# h', marks)])]))),
    doc([p([t('a # h', marks)])]));
}
// a blank line inside marked text is the same degrade — escaping cannot save it, the line would
// end the block before the closing delimiter is ever reached
check('bug-a2m-marked-blank-line', a2m(doc([p([t('a\n\nb', [mStrong])])])), '**a  b**');

// ------------- bug-30: an href needing the <…> form that itself holds an angle bracket --

// the bare form is unparseable once the href has whitespace, so the offending angle brackets
// are percent-encoded rather than emitting markdown md-to-adf cannot read back
check('bug-a2m-link-angle-in-href',
  a2m(doc([p([t('d', [mLink('https://x.dev/a <b')])])])), '[d](<https://x.dev/a %3Cb>)');
check('bug-m2a-link-angle-in-href', m2a('[d](<https://x.dev/a %3Cb>)'), doc([
  p([t('d', [mLink('https://x.dev/a %3Cb')])]),
]));

// ------------------------- bug-31: a delimiter char at the EDGE of marked text --

// the character fuses with the delimiter run the mark emits (`**` + `*.liquid` = `***.liquid`),
// which reads back as ONE unmarked node: the mark is gone and the text gained a character
check('bug-a2m-strong-star-edge', a2m(doc([p([t('use '), t('*.liquid', [mStrong]), t(' files')])])),
  'use **\\*.liquid** files');
check('bug-a2m-em-star-only', a2m(doc([p([t('**', [mEm])])])), '*\\*\\**');
check('bug-a2m-strong-star-lead', a2m(doc([p([t('**kwargs', [mStrong])])])), '**\\**kwargs**');
check('bug-a2m-strike-tilde-edge', a2m(doc([p([t('~x', [mStrike])])])), '~~\\~x~~');
// the padding a mark pushes outside its delimiters must not hide the edge character
const starPadded = doc([p([t('a'), t(' *x ', [mStrong]), t('b')])]);
check('bug-a2m-star-edge-padded', a2m(starPadded), 'a **\\*x** b');
check('bug-roundtrip-star-edge-padded', m2a(a2m(starPadded)),
  doc([p([t('a '), t('*x', [mStrong]), t(' b')])]));

// ------------------ bug-32: a separator-row lookalike inside a plain paragraph --

// md-to-adf accepts a PIPELESS table, so an unescaped `---|---` promotes the line above it to a
// table header and the paragraph (with its hard breaks) is gone
const sepProse = doc([p([t('A | B'), hb, t('---|---'), hb, t('1 | 2')])]);
check('bug-a2m-escape-sep-row', a2m(sepProse), 'A | B  \n\\---|---  \n1 | 2');
check('bug-roundtrip-sep-row', m2a(a2m(sepProse)), sepProse);
// the alignment form starts with `:`, which md-to-adf does not unescape — the backslash has to
// go on the first dash or it would stick and grow on every cycle
const sepAlign = doc([p([t('A | B'), hb, t(':---|---:'), hb, t('1 | 2')])]);
check('bug-a2m-escape-sep-row-align', a2m(sepAlign), 'A | B  \n:\\---|---:  \n1 | 2');
check('bug-roundtrip-sep-row-align', m2a(a2m(sepAlign)), sepAlign);

// ---------------------------------------------------- bug-33: an INDENTED fence --

// unrecognized, the body is read as prose and the inline layer rewrites the code: `\+` loses its
// backslash and a trailing `\` becomes a hard break. The opening indent comes off the body lines.
check('bug-m2a-fence-indented', m2a("  ```bash\n  grep -nE '^\\+[^+]' \\\\\n    | grep x\n  ```"), doc([
  cb("grep -nE '^\\+[^+]' \\\\\n  | grep x", 'bash'),
]));
check('bug-m2a-fence-indented-close-padded', m2a('   ```\n   x\n   ```   '), doc([cb('x')]));
// a fence indented between list items may land as a top-level codeBlock — what must never happen
// is its body being rewritten
check('bug-m2a-fence-indented-in-list', m2a('- one\n  ```\n  a\\\n  ```\n- two'), doc([
  ul([li([p([t('one')])])]),
  cb('a\\'),
  ul([li([p([t('two')])])]),
]));

// ------------------- bug-34: code content across a break in a single-line construct --

// the break degrades to a space at the NODE level: a regex over the rendered markdown cannot tell
// a hard-break backslash from one that is code-span content, and deletes the latter
const cellCodeBreak = doc([tbl([
  trow([th([p([t('H')])])]),
  trow([td([p([t('curl -X POST \\\nhttps://x', [mCode])])])]),
])]);
check('bug-a2m-cell-code-backslash', a2m(cellCodeBreak),
  '| H |\n| --- |\n| `curl -X POST \\ https://x` |');
check('bug-roundtrip-cell-code-backslash', m2a(a2m(cellCodeBreak)),
  doc([tbl([
    trow([th([p([t('H')])])]),
    trow([td([p([t('curl -X POST \\ https://x', [mCode])])])]),
  ])]));
check('bug-a2m-heading-code-backslash',
  a2m(doc([{ type: 'heading', attrs: { level: 2 }, content: [t('a \\\nb', [mCode])] }])), '## `a \\ b`');
check('bug-a2m-listitem-code-backslash',
  a2m(doc([ul([li([p([t('x')]), cb('curl \\\nhttp://y')])])])), '- x `curl \\ http://y`');

// ------------------------- bug-35: a codeBlock inside a table cell leaks its fence --

// a fence in a cell reads back as a code span holding the LANGUAGE word, so the cell path gets
// the same degrade a list item already had
const cellCodeBlock = doc([tbl([trow([th([p([t('H')])])]), trow([td([cb('a\nb', 'sh')])])])]);
check('bug-a2m-cell-codeblock', a2m(cellCodeBlock), '| H |\n| --- |\n| `a b` |');
check('bug-a2m-cell-empty-codeblock',
  a2m(doc([tbl([trow([th([p([t('H')])])]), trow([td([cb('')])])])])), '| H |\n| --- |\n|  |');

// ---------------------------- bug-36: a non-string or missing value in the ADF --

// json-slim hands this converter ADF straight off an MCP response — a crash there means NO
// markdown at all, so a malformed node degrades instead
check('bug-a2m-nonstring-text', run(A2M, JSON.stringify(doc([p([{ type: 'text', text: 123 }])]))), '123');
check('bug-a2m-null-codeblock-child',
  run(A2M, JSON.stringify(doc([ul([li([p([t('x')]), { type: 'codeBlock', content: [null] }])])]))), '- x');
check('bug-a2m-null-codeblock-block',
  run(A2M, JSON.stringify(doc([{ type: 'codeBlock', content: [null] }, p([t('after')])]))), '```\n\n```\n\nafter');
check('bug-a2m-nonstring-unknown-block',
  run(A2M, JSON.stringify(doc([{ type: 'weird', text: 7 }]))), '7');

// ------------------------------------------------------ round-trip properties --

// md → adf → md must reach a fixpoint on the FIRST pass: whatever the pair normalizes
// (marks, escapes, fence lengths) it must normalize identically every time, or an
// edit-and-write-back cycle keeps mutating the field.
//
// A markdown fixpoint on its own is NOT discriminating — it only says the pair damages the
// input consistently — so every entry also asserts the STORED ADF stops changing, and the
// entries whose markdown is already in canonical emit form assert md1 === md. `leakFree`
// entries additionally assert no markdown delimiter survives as literal text.
const LEAK_RE = /`|\]\(|\*\*|~~/;
function leakedText(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (node.type === 'text' && !(node.marks || []).some((m) => m.type === 'code')
    && LEAK_RE.test(node.text || '')) out.push(node.text);
  for (const c of node.content || []) leakedText(c, out);
  return out;
}
const MD_CORPUS = [
  ['nested-marks', '**bold `code`** then **[link](https://x.dev)** and **b *i* t**', { leakFree: true }],
  ['strongem-strike', 'a ***hot*** path with ~~old~~ and `snake_case_id`', { canonical: true, leakFree: true }],
  ['emphasis-literal', 'Compute a * b * c and 2 ** 3 ** 4 with SELECT *', { canonical: true }],
  // an INTRAWORD run: the opener a later one shadows stays literal, so `2**3` keeps its stars
  // instead of the mark spanning the wrong text — the literal `**` is the point, not a leak
  ['emphasis-intraword', '2**3 is 8 and **bold** text', { canonical: true }],
  ['table-pipe', '| Col | Other |\n| --- | --- |\n| a\\|b | z |\n| `c|d` | w |', { canonical: true }],
  ['fence-inner', '````md\na\n```\nb\n````\n\nafter', { canonical: true }],
  ['fence-infostring', '```c++\nint x;\n```', { canonical: true }],
  // an INDENTED fence: the body must stay verbatim (a `\+` keeps its backslash, a trailing `\`
  // is not a line break) — the emitted form is unindented, so it is not canonical
  ['fence-indented', "  ```bash\n  grep -nE '^\\+[^+]' \\\\\n  ```"],
  ['link-edges', '[docs](https://x.dev/a(b)c) plus [a [b] c](https://x.dev/z) and [q](https://x.dev/?a=1&b=2)', { canonical: true }],
  ['code-span-tick', '``code with ` tick`` and ```x``` inline'],
  ['literal-structure', '\\# not a heading\n\n\\- not a list\n\n1\\. not ordered\n\n\\> not a quote', { canonical: true, leakFree: true }],
  ['hardbreak', 'line one  \nline two', { canonical: true, leakFree: true }],
  ['empty-heading', '# \n\ntext'],
  ['quote-hardbreak', '> a  \n> b', { canonical: true, leakFree: true }],
  ['code-pad-space', '`  x  `', { canonical: true }],
  ['table-link-pipe', '| H |\n| --- |\n| [a\\|b](https://x.dev/?a=1\\|2) |', { canonical: true }],
  ['nested-lists', '1. AC 1\n  - sub a\n  - sub b\n2. AC 2', { canonical: true, leakFree: true }],
  ['mixed-doc', '# Title\n\nBody with `code`.\n\n> quoted\n\n---\n\n- one\n- two', { canonical: true, leakFree: true }],
  // the edges the six bugs and their regressions live on
  ['adjacent-marks', '**a***b***c**', { leakFree: true }],
  ['adjacent-em-marks', '*a****b****c*', { canonical: true, leakFree: true }],
  ['code-blank', '`  `', { canonical: true }],
  ['pipeless-table', 'Intro\nA | B\n--- | ---\n1 | 2', { leakFree: true }],
  ['autolink', 'see <https://n.test/p> here', { canonical: true, leakFree: true }],
  // emitted back in the <…> form (lossless for any scheme and trailing dot), so not canonical
  ['bare-url', 'see https://x.dev/a. (https://x.dev/b) done', { leakFree: true }],
  ['quote-multiblock', '> a\n>\n> ```\n> x\n> ```', { canonical: true }],
  ['label-code-bracket', '[`a]b`](https://u.test)', { canonical: true }],
  ['regex-backslash', 'Match ^\\d+\\.\\d+$ here', { leakFree: true }],
  ['pipe-prose', '\\|a|b|  \n\\|---|---|  \n\\|1|2|', { canonical: true, leakFree: true }],
  // NBSP at the START and in the middle — a trailing one is untestable here, `check` trimEnd()s
  // both sides and JS trimEnd() eats U+00A0 (bug-roundtrip-nbsp-trailing covers that edge)
  ['nbsp', NB + 'a' + NB + 'and', { canonical: true, leakFree: true }],
  ['hardbreak-double', 'a  \n\\\nb', { canonical: true, leakFree: true }],
  ['listitem-code', '- run `bin/rake db:migrate`', { canonical: true }],
];
// strip only the newline the CLI appends — JS trimEnd() would eat a trailing U+00A0
const noEOL = (s) => s.replace(/\n+$/, '');
for (const [label, md, opts = {}] of MD_CORPUS) {
  const adf1 = m2a(md);
  const md1 = noEOL(a2m(adf1));
  const adf2 = m2a(md1);
  const md2 = noEOL(a2m(adf2));
  const adf3 = m2a(md2);
  check(`prop-md-fixpoint[${label}]`, md2, md1);
  // a markdown fixpoint alone can still hide a mark boundary that keeps shifting or delimiters
  // that pile up as literal text, so the STORED ADF has to stop changing too. One boundary
  // normalization on the first pass is expected (a space inside a mark moves outside its
  // delimiters); from the second pass on the ADF must be identical.
  check(`prop-md-adf-stable[${label}]`, adf3, adf2);
  if (opts.canonical) check(`prop-md-canonical[${label}]`, md1, md);
  if (opts.leakFree) check(`prop-md-no-leak[${label}]`, leakedText(adf1), []);
}

// adf → md → adf must be an IDENTITY for the node types both converters support
// (mark ORDER is normalized by the markdown nesting, so it is sorted before comparing).
const sortMarks = (v) => (Array.isArray(v) ? v.map(sortMarks)
  : (v && typeof v === 'object'
    ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k,
      k === 'marks' && Array.isArray(x)
        ? x.map(sortMarks).sort((a, b) => (a.type < b.type ? -1 : 1))
        : sortMarks(x)]))
    : v));
const ADF_CORPUS = [
  ['heading-para', doc([{ type: 'heading', attrs: { level: 2 }, content: [t('Approach')] }, p([t('body')])])],
  ['empty-heading', emptyHeading],
  ['marks', marks],
  ['code-link', codeLink],
  ['bold-link', doc([p([t('link', [mLink('https://x.dev'), mStrong])])])],
  ['strongem', doc([p([t('hot', [mStrong, mEm])])])],
  ['code-inner-tick', doc([p([t('a`b', [mCode])])])],
  ['table-pipe', pipeTable],
  ['table-code-pipe', codePipeCell],
  ['table-link-pipe', cellLink],
  ['code-pad-space', codeSpaces],
  ['quote-hardbreak', doc([quote([p([t('a'), hb, t('b')])])])],
  ['codeblock-inner-fence', innerFence],
  ['nested-ol-ul', nestedOl],
  ['deep-ul', deepUl],
  ['quote-rule', doc([{ type: 'blockquote', content: [p([t('q')])] }, { type: 'rule' }])],
  ['literal-structure', prose],
  ['hardbreak', hardBreak],
  ['link-paren', parenHref],
  ['link-unbalanced', oddHref],
  ['ol-start', doc([ol([li([p([t('three')])]), li([p([t('four')])])], { order: 3 })])],
  // the edges the six bugs and their regressions live on
  ['trailing-backslash', doc([p([t('a\\'), t('b', [mCode])])])],
  ['trailing-backslash-strong', doc([p([t('a\\', [mStrong])])])],
  ['code-all-space', codeAllSpace],
  ['code-link-bracket', doc([p([t('items[0]', [mCode, mLink('https://x.dev/d')])])])],
  ['code-link-unbalanced-bracket', doc([p([t('a]b', [mCode, mLink('https://u.test')])])])],
  ['hardbreak-double', hbDouble],
  ['pipe-prose', pipeProse],
  ['hardbreak-pipe', hbPipe],
  ['nbsp-in-strong', nbspStrong],
  ['adjacent-marks', doc([p([t('a', [mStrong]), t('b', [mStrong, mEm]), t('c', [mStrong])])])],
  ['quote-two-paras', doc([quote([p([t('a')]), p([t('b')])])])],
  ['quote-codeblock', doc([quote([p([t('note')]), cb('x')])])],
  ['quote-degraded-nested', doc([quote([p([t('> deep')])])])],
  ['autolink', doc([p([t('see '), t('https://n.test/p', [mLink('https://n.test/p')])])])],
  ['literal-backslash-prose', regexProse],
  ['strong-star-edge', doc([p([t('use '), t('*.liquid', [mStrong]), t(' files')])])],
  ['em-star-only', doc([p([t('**', [mEm])])])],
  ['strong-star-lead', doc([p([t('**kwargs', [mStrong])])])],
  ['strike-tilde-edge', doc([p([t('~x', [mStrike])])])],
];
for (const [label, adf] of ADF_CORPUS) {
  check(`prop-adf-identity[${label}]`, sortMarks(m2a(a2m(adf))), sortMarks(adf));
}

console.log(`adf-md fixtures: ${pass} passed, ${fail} failed`);
if (fail) { console.log(failures.join('\n')); process.exit(1); }
