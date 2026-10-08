#!/usr/bin/env node
// Fixture suite for plugins/base/scripts/md-to-adf.cjs (base:jira-writer's converter). The read side
// is slim's adf engine (plugins/slim/scripts/engines/adf.cjs), so the round trips here run
// markdown → base's writer → slim's reader → base's writer. adf-md-fixtures.mjs keeps covering
// fnd's pair. Exit 0 = all green.
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const M2A = path.join(ROOT, 'plugins/base/scripts/md-to-adf.cjs');
const require = createRequire(import.meta.url);
const { adfToMarkdown } = require(path.join(ROOT, 'plugins/slim/scripts/engines/adf.cjs'));
const { NAME_TO_HEX } = require(path.join(ROOT, 'plugins/base/scripts/adf-colors.cjs'));

let pass = 0, fail = 0;
const failures = [];
const canon = (v) => Array.isArray(v) ? v.map(canon)
  : (v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
function check(name, actual, expected) {
  const a = typeof actual === 'string' ? actual.trimEnd() : JSON.stringify(canon(actual));
  const e = typeof expected === 'string' ? expected.trimEnd() : JSON.stringify(canon(expected));
  if (a === e) pass++;
  else { fail++; failures.push(`[${name}]\n  expected: ${JSON.stringify(e)}\n  actual:   ${JSON.stringify(a)}`); }
}

const cli = (input, args = []) => spawnSync('node', [M2A, ...args], { input, encoding: 'utf8' });
const m2a = (md, args = []) => JSON.parse(execFileSync('node', [M2A, ...args], { input: md, encoding: 'utf8', stdio: 'pipe' }));

const doc = (content) => ({ type: 'doc', version: 1, content });
const p = (content) => ({ type: 'paragraph', content });
const t = (text, marks) => (marks ? { type: 'text', text, marks } : { type: 'text', text });
const h = (level, content) => ({ type: 'heading', attrs: { level }, content });
const li = (content) => ({ type: 'listItem', content });
const ul = (content) => ({ type: 'bulletList', content });
const ol = (content) => ({ type: 'orderedList', content });
const strong = { type: 'strong' };
const em = { type: 'em' };
const code = { type: 'code' };
const link = (href) => ({ type: 'link', attrs: { href } });

// ---------------------------------------------------------------- the converter's output --
check('m2a-heading-paragraph', m2a('# Title\n\nSome text'), doc([h(1, [t('Title')]), p([t('Some text')])]));
check('m2a-marks', m2a('**b** *i* `c` ~~s~~'),
  doc([p([t('b', [strong]), t(' '), t('i', [em]), t(' '), t('c', [code]), t(' '), t('s', [{ type: 'strike' }])])]));
check('m2a-link', m2a('[x](https://l.test)'), doc([p([t('x', [link('https://l.test')])])]));
check('m2a-autolink', m2a('<https://l.test/a>'), doc([p([t('https://l.test/a', [link('https://l.test/a')])])]));
check('m2a-bare-url', m2a('see https://x.test/p?_ab=0&_fd=0.'),
  doc([p([t('see '), t('https://x.test/p?_ab=0&_fd=0', [link('https://x.test/p?_ab=0&_fd=0')]), t('.')])]));
check('m2a-snake-case', m2a('customfield_10038 stays'), doc([p([t('customfield_10038 stays')])]));
check('m2a-lists', m2a('- a\n- b\n\n1. one\n2. two'),
  doc([ul([li([p([t('a')])]), li([p([t('b')])])]), ol([li([p([t('one')])]), li([p([t('two')])])])]));
check('m2a-nested-list', m2a('1. AC 1\n  - sub a\n2. AC 2'),
  doc([ol([li([p([t('AC 1')]), ul([li([p([t('sub a')])])])]), li([p([t('AC 2')])])])]));
check('m2a-code-block', m2a('```js\na();\n```'), doc([{ type: 'codeBlock', attrs: { language: 'js' }, content: [t('a();')] }]));
check('m2a-rule-quote', m2a('> q\n\n---'), doc([{ type: 'blockquote', content: [p([t('q')])] }, { type: 'rule' }]));
const green = NAME_TO_HEX.green;
check('m2a-color-name', m2a('{color:green}ok{color}'), doc([p([t('ok', [{ type: 'textColor', attrs: { color: green } }])])]));
check('m2a-color-hex', m2a('{color:#ABCDEF}ok{color}'), doc([p([t('ok', [{ type: 'textColor', attrs: { color: '#abcdef' } }])])]));
check('m2a-color-unknown-literal', m2a('{color:mauve}x{color}'), doc([p([t('{color:mauve}x{color}')])]));
check('m2a-table', m2a('| A | B |\n| --- | --- |\n| 1 | 2 |').content[0].type, 'table');
check('m2a-no-tables', m2a('| A | B |\n| --- | --- |\n| 1 | 2 |', ['--no-tables']).content[0].type, 'bulletList');

// ---------------------------------------------------------------------- the CLI contract --
{
  const r = cli('# Hi\n\ntext');
  const line = (r.stderr.match(/^md-to-adf: (\d+) bytes$/m) || [])[1];
  check('cli-ok-exit', r.status, 0);
  check('cli-stdout-one-line', r.stdout.trimEnd().split('\n').length, 1);
  check('cli-bytes-line', Number(line), Buffer.byteLength(r.stdout.trimEnd(), 'utf8'));
  const pretty = cli('# Hi\n\ntext', ['--pretty']);
  check('cli-pretty-same-doc', JSON.stringify(JSON.parse(pretty.stdout)), r.stdout.trimEnd());
  check('cli-pretty-bytes-minified', (pretty.stderr.match(/^md-to-adf: (\d+) bytes$/m) || [])[1], line);
}
for (const [label, input] of [['empty', ''], ['blank', '  \n\t\n']]) {
  const r = cli(input);
  check(`cli-${label}-exit`, r.status, 2);
  check(`cli-${label}-stdout`, r.stdout, '');
  check(`cli-${label}-stderr`, /error: empty input/.test(r.stderr), true);
}
{
  const r = cli('x', ['--bogus']);
  check('cli-unknown-option-exit', r.status, 2);
  check('cli-unknown-option-stdout', r.stdout, '');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'base-m2a-'));
  const f = path.join(dir, 'in.md');
  fs.writeFileSync(f, '# File\n\nbody');
  const fromFile = spawnSync('node', [M2A, f], { encoding: 'utf8' });
  check('cli-file-equals-stdin', fromFile.stdout, cli('# File\n\nbody').stdout);
  const two = spawnSync('node', [M2A, f, f], { encoding: 'utf8' });
  check('cli-two-files-exit', two.status, 2);
  const missing = spawnSync('node', [M2A, path.join(dir, 'nope.md')], { encoding: 'utf8' });
  check('cli-missing-file-exit', missing.status, 1);
  check('cli-missing-file-stdout', missing.stdout, '');
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------- round trips through slim's adf engine --
// markdown → ADF (base) → markdown (slim) → ADF (base): the visible text survives, and one cycle is
// a fixpoint. Mark boundaries may move onto a neighbouring space on the first cycle (`**bold **`
// → `**bold** `), which Jira renders the same; they never move again.
const textOf = (node) => (node && typeof node === 'object'
  ? (node.type === 'text' ? node.text : (Array.isArray(node.content) ? node.content.map(textOf).join('') : ''))
  : '');
const squash = (s) => s.replace(/\s+/g, '');
const cycle = (adf, args) => m2a(adfToMarkdown(adf), args);
const CORPUS = [
  '# Heading\n\nParagraph with **bold**, *em*, `code` and ~~strike~~.',
  '## Technical Approach\n\n1. AC 1\n  - sub a\n  - sub b\n2. AC 2',
  '- Parent\n  - Child 1\n  - Child 2\n- Sibling',
  '- L1\n  - L2\n    - L3',
  'see [`config.js`](https://x.test/f)',
  '**bold `code`**',
  '**[link](https://x.dev)**',
  '**bold *it* tail**',
  '**Status: {color:green}Pass{color}**',
  '{color:red}**Fail** — x{color}',
  '**see https://x.dev/b**',
  'Preview: https://store.test/?preview_theme_id=1&_ab=0&_fd=0',
  'Bare <https://x.test/a_b> and [named](https://x.test/c)',
  '```md\na\n```\nb\n```',
  '````md\na\n```\nb\n````\n\nafter',
  '> quoted\n>\n> - item\n\n---\n\nafter',
  '| Key | Value |\n| --- | --- |\n| mode | a\\|b |',
  '| H |\n| --- |\n| `a|b` |',
  'Literal \\# not a heading, \\- not a list, 1\\. not ordered',
  'snake_case_name and customfield_10038 and __init__',
  'line one  \nline two\\\nline three',
  'Intro\n\n|  |  |\n| --- | --- |',
  'Fields:\nName | Type\n--- | ---\nsku | text',
  '### Setup\n\n1. Open the page\n2. Click **Add**\n\n### Expected\n\nThe drawer opens.',
  'Unicode — “quotes”, non breaking, emoji 🙂',
];
for (const [i, md] of CORPUS.entries()) {
  for (const args of [[], ['--no-tables']]) {
    const label = `${i}${args.length ? '-notables' : ''}`;
    const a1 = m2a(md, args);
    const a2 = cycle(a1, args);
    check(`roundtrip-text[${label}]`, squash(textOf(a2)), squash(textOf(a1)));
    check(`roundtrip-fixpoint[${label}]`, cycle(a2, args), a2);
  }
}

console.log(`base-md-to-adf: ${pass} passed, ${fail} failed`);
if (fail) { console.log(failures.join('\n')); process.exit(1); }
