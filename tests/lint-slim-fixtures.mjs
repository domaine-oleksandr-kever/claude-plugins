#!/usr/bin/env node
// Suite for plugins/slim/scripts/engines/lint.cjs — the lint engine — and its delivery: sniff rows
// (each grammar, the guards that stay ahead), compress rows with exact bytes, identifier preservation
// (every kept location is in the input, counts equal the tool's own summary, severity order), the
// fit stages, determinism, and the Bash / MCP / Read channels through scripts/slim.cjs end to end.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const SCRIPTS = path.join(ROOT, 'plugins/slim/scripts');
const FIX = path.join(ROOT, 'tests/fixtures');
const require = createRequire(import.meta.url);
const { compress, sniff, REGISTRY } = require(path.join(SCRIPTS, 'engines/index.cjs'));
const lint = require(path.join(SCRIPTS, 'engines/lint.cjs'));
const emit = require(path.join(SCRIPTS, 'delivery/emit.cjs'));
const ch = require(path.join(SCRIPTS, 'delivery/channels.cjs'));

let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) pass++;
  else { fail++; failures.push(`[${name}] ${detail || ''}`); }
}
const eq = (name, actual, expected) => check(name, JSON.stringify(actual) === JSON.stringify(expected),
  `\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
const bytes = (s) => Buffer.byteLength(s, 'utf8');
const fx = (f) => readFileSync(path.join(FIX, f), 'utf8');
const O = { maxMs: 0 };

const ESLINT = fx('eslint-stylish.txt');
const THEME = fx('lint-theme-check.txt');
const TSC = fx('tsc.txt');
const THEME_LIQUID = fx('theme-check.txt');
const TESTOUT = fx('test-output.txt');
const APPLOG = fx('app.log');

// The same problems in other grammars, built from the fixtures so the counts stay comparable.
const stylishRows = (() => {
  const rows = [];
  let file = null;
  for (const l of ESLINT.split('\n')) {
    const m = /^\s+(\d+):(\d+)\s+(error|warning)\s+(.+?)(?:\s{2,}(\S+))?$/.exec(l);
    if (m && file) rows.push({ file, line: m[1], col: m[2], level: m[3], msg: m[4], rule: m[5] || '' });
    else if (/^\S/.test(l) && !/problems/.test(l)) file = l;
  }
  return rows;
})();
const UNIX = `${stylishRows.slice(0, 120).map((r) => `${r.file}:${r.line}:${r.col}: ${r.msg} [${r.level === 'error' ? 'Error' : 'Warning'}${r.rule ? `/${r.rule}` : ''}]`).join('\n')}\n\n120 problems\n`;
const STYLELINT_UNIX = Array.from({ length: 40 }, (_, i) => `src/styles/card-${i % 7}.css:${10 + i}:${1 + (i % 9)}: Expected "${['#FFF', '#000', '#Abc'][i % 3]}" to be "${['#fff', '#000', '#abc'][i % 3]}" (color-hex-case) [${i % 4 ? 'error' : 'warning'}]`).join('\n');
const PRETTIER = `Checking formatting...\n${Array.from({ length: 40 }, (_, i) => `[warn] src/${['sections', 'snippets', 'assets'][i % 3]}/file-${i}.${['js', 'css', 'ts'][i % 3]}`).join('\n')}\n[warn] Code style issues found in 40 files. Run Prettier with --write to fix.\n`;
const TSC_PRETTY = TSC.split('\n').filter((l) => /\(\d+,\d+\)/.test(l)).slice(0, 30).map((l) => {
  const m = /^(.*?)\((\d+),(\d+)\): (error \S+: .*)$/.exec(l);
  return `${m[1]}:${m[2]}:${m[3]} - ${m[4]}\n\n${m[2]} const value = compute(input);\n    ~~~~~\n`;
}).join('\n');
const NESTED = THEME.split('\n').filter((l) => l.startsWith('[')).map((l) => {
  const m = /^\[(\w+)\] (\S+?):(\d+):\d+ (.*)$/.exec(l);
  return `${m[2]}\n  ${m[1]}: ${m[4]} at line ${m[3]}`;
}).join('\n');
const GREP = Array.from({ length: 60 }, (_, i) => `src/sections/main-${i % 9}.js:${10 + i}:5: const price = format(${i});`).join('\n');
const MIXED = `${ESLINT}\nPASS src/cart.test.js\nTests:       12 passed, 12 total\n`;
// tsc with its indented elaboration lines under every `every`-th error.
const tscElab = (every) => TSC.split('\n').map((l, i) => (/\(\d+,\d+\): error /.test(l) && i % every === 0
  ? `${l}\n  Type 'Item${i}' is not assignable to type 'Line'.\n    Property 'qty${i}' is missing in type 'Item${i}'.` : l)).join('\n');
// grep hits whose text starts with a level word: grammar-shaped, but not a linter's output.
const GREP_LOGS = Array.from({ length: 200 }, (_, i) => `logs/app-${i % 5}.log:${1000 + i}:error: connection refused to db host 10.0.0.${i % 9} user=u${i}`).join('\n');
// A stylish record whose message reads like a summary line must stay a record of its file.
const SUMMARYISH = `/p/a.js\n${Array.from({ length: 30 }, (_, i) => `  ${i + 1}:1  error  'v${i}' is not defined  no-undef`).join('\n')}\n\n/p/b.js\n${Array.from({ length: 6 }, (_, i) => `  ${i + 1}:3  warning  Expected 3 warnings at most, found 4  custom/max-warn`).join('\n')}\n  9:1  error  Expected at most 2 errors found per handler  custom/max-errors\n\n✖ 37 problems (31 errors, 6 warnings)\n`;
// Ties in group size and file count: the order is by code unit whatever the locale (Danish sorts 'aa' after 'z').
const TIES = `x.js\n${Array.from({ length: 5 }, (_, i) => `  ${i + 1}:1  error  bad  rule-aa`).join('\n')}\n${['aa.js', 'zz.js', 'äb.js'].map((f) => `\n${f}\n${Array.from({ length: 10 }, (_, i) => `  ${i + 1}:1  error  bad  rule-aa\n  ${i + 1}:2  error  bad  rule-zz`).join('\n')}`).join('\n')}\n\n✖ 65 problems (65 errors, 0 warnings)\n`;

// ES — sniff: each grammar is lint; the guards and the other detectors stay ahead or apart
{
  for (const [name, data, engine, reason] of [
    ['eslint-stylish', ESLINT, 'lint', 'lint'],
    ['theme-check-text', THEME, 'lint', 'lint'],
    ['tsc', TSC, 'lint', 'lint'],
    ['eslint-unix', UNIX, 'lint', 'lint'],
    ['stylelint-unix', STYLELINT_UNIX, 'lint', 'lint'],
    ['prettier-check', PRETTIER, 'lint', 'lint'],
    ['tsc-pretty', TSC_PRETTY, 'lint', 'lint'],
    ['theme-check-nested', NESTED, 'lint', 'lint'],
    ['theme-check-quoting-liquid', THEME_LIQUID, 'text', 'template'],
    ['jest-failure', TESTOUT, 'text', 'test-output'],
    ['lint-plus-test-summary', MIXED, 'text', 'test-output'],
    ['grep-hits', GREP, 'text', 'prose'],
    ['tsc-elaborated-all', tscElab(1), 'lint', 'lint'],
    ['tsc-elaborated-every-4th', tscElab(4), 'lint', 'lint'],
    ['app-log', APPLOG, 'log', 'log'],
    ['short-lint', ESLINT.split('\n').slice(0, 25).join('\n'), 'text', 'prose'],
  ]) {
    const s = sniff({ data });
    eq(`LS-${name}`, [s.engine, s.reason], [engine, reason]);
  }
  const fenced = sniff({ data: `Lint found problems:\n\`\`\`\n${ESLINT}\`\`\`\n` });
  eq('LS-fence', [fenced.engine, fenced.reason], ['lint', 'fence']);
  check('LS-confidence-footer', sniff({ data: ESLINT }).confidence > sniff({ data: STYLELINT_UNIX }).confidence, 'a summary line raises confidence');
}

// The groups of an output and the location lines kept under them.
const GROUP = /^\S.* \((E|W|N) [\d,]+\) — /;
const groupLines = (out) => out.split('\n').filter((l) => GROUP.test(l));
const locLines = (out) => out.split('\n\n').filter((b) => GROUP.test(b)).flatMap((b) => b.split('\n').slice(1))
  .filter((l) => !l.startsWith('  … ') && !l.startsWith('    ')).map((l) => l.slice(2).split('  ')[0]);
const header = (out) => out.split('\n')[0];
const count = (out, word) => Number((new RegExp(`([\\d,]+) ${word}`).exec(header(out)) || [])[1]?.replace(/,/g, ''));

// LC — compress: decision, exact bytes, marker, spill suffix, counts against the tool's own summary
{
  const rows = [
    ['eslint', ESLINT, 13374, /\((\d+) errors, (\d+) warnings\)/, ['stylish']],
    ['theme-check', THEME, 5946, /\((\d+) errors, (\d+) warnings, (\d+) suggestions\)/, ['theme-check']],
    ['tsc', TSC, 2793, /Found (\d+) errors/, ['tsc']],
  ];
  for (const [name, data, outBytes, summary, fmt] of rows) {
    const r = compress({ data }, { ...O, trace: true });
    eq(`LC-${name}-decision`, [r.engine, r.decision, r.stats.stages], ['lint', 'compressed', ['lint']]);
    eq(`LC-${name}-bytes`, [r.stats.bytesIn, r.stats.bytesOut], [bytes(data), outBytes]);
    check(`LC-${name}-marker`, r.text.startsWith(`<<slim-lint>> ${fmt.join('+')} · `), header(r.text));
    check(`LC-${name}-spill-ext`, r.spill.suggestedName.endsWith(REGISTRY.lint.ext) && r.spill.payload === data, r.spill.suggestedName);
    const s = summary.exec(data);
    eq(`LC-${name}-errors`, count(r.text, 'errors'), Number(s[1]));
    if (s[2]) eq(`LC-${name}-warnings`, count(r.text, 'warnings'), Number(s[2]));
    if (s[3]) eq(`LC-${name}-notes`, count(r.text, 'notes'), Number(s[3]));
    const total = groupLines(r.text).reduce((n, l) => n + Number(/\((?:E|W|N) ([\d,]+)\)/.exec(l)[1].replace(/,/g, '')), 0);
    eq(`LC-${name}-every-problem-counted`, total, count(r.text, 'problems'));
    const ranks = groupLines(r.text).map((l) => 'EWN'.indexOf(/\((E|W|N) /.exec(l)[1]));
    check(`LC-${name}-severity-order`, ranks.every((x, i) => i === 0 || ranks[i - 1] <= x), ranks.join(''));
    check(`LC-${name}-summary-verbatim`, r.text.includes(data.split('\n').filter((l) => summary.test(l))[0]), 'tool summary line missing');
    check(`LC-${name}-footer`, r.text.endsWith('full list: Read the original windowed, or rerun the linter on one file'), r.text.slice(-120));
  }
  eq('LC-eslint-problems', count(compress({ data: ESLINT }, O).text, 'problems'), 400);
  eq('LC-theme-check-problems', count(compress({ data: THEME }, O).text, 'problems'), 120);
  eq('LC-tsc-problems', count(compress({ data: TSC }, O).text, 'problems'), 60);
  for (const [name, data] of [['unix', UNIX], ['stylelint', STYLELINT_UNIX], ['tsc-pretty', TSC_PRETTY], ['nested', NESTED]]) {
    const r = compress({ data }, O);
    eq(`LC-${name}`, [r.engine, r.decision], ['lint', 'compressed']);
  }
  // A prettier list is all file names: every fold names every file, so only a size target folds it.
  eq('LC-prettier-no-target', compress({ data: PRETTIER }, O).reason, 'no-gain');
  const p = compress({ data: PRETTIER }, { ...O, trace: true, targetBytes: 1000 });
  eq('LC-prettier-fit', [p.decision, p.stats.stages], ['compressed', ['lint', 'files-8']]);
  eq('LC-prettier-group', [groupLines(p.text)[0], count(p.text, 'problems')], ['prettier (W 40) — not formatted', 40]);
  check('LC-prettier-other-line', p.text.includes('other output (1 line):\nChecking formatting...'), p.text.slice(-400));
  // The unix rows are the stylish fixture's first 120 problems: the same rules, the same counts per level.
  const nested = compress({ data: NESTED }, O).text;
  eq('LC-nested-counts', [count(nested, 'problems'), count(nested, 'errors'), count(nested, 'notes')], [120, 34, 29]);
  check('LC-nested-loc', /^ {2}sections\/main-product-0\.liquid:\d+$/m.test(nested), nested.slice(0, 600));
  const longNote = compress({ data: `${'Oops! '.repeat(2000)}\n${ESLINT}` }, O).text;
  check('LC-note-clipped', /^(Oops! )+…?.* … \[\+[\d,]+ chars\]$/m.test(longNote) && bytes(longNote) < bytes(compress({ data: ESLINT }, O).text) + 400, longNote.slice(-700));
  const u = compress({ data: UNIX }, O);
  // tsc elaborations stay under their error, never in 'other output'.
  const el = compress({ data: tscElab(1) }, O).text;
  eq('LC-tsc-elab-counts', [count(el, 'problems'), count(el, 'errors')], [60, 60]);
  check('LC-tsc-elab-attached', !el.includes('other output') && /^ {2}src\/\S+\(\d+,\d+\).*\n {4}Type 'Item\d+' is not assignable to type 'Line'\.\n {6}Property 'qty\d+' is missing/m.test(el), el.slice(0, 900));
  const e6 = compress({ data: tscElab(6) }, O).text;
  check('LC-tsc-elab-sparse', !e6.includes('other output'), e6.slice(-600));
  // Records whose message reads like a summary are counted under their file and rule.
  const si = compress({ data: SUMMARYISH }, O).text;
  eq('LC-summaryish-counts', [count(si, 'problems'), count(si, 'errors'), count(si, 'warnings'), count(si, 'files'), count(si, 'rules')], [37, 31, 6, 2, 3]);
  check('LC-summaryish-located', si.includes('  /p/b.js:9:1') && si.includes('  /p/b.js:1:3') && !si.includes('other output'), si);
  eq('LC-unix-errors', count(u.text, 'errors'), stylishRows.slice(0, 120).filter((r) => r.level === 'error').length);
}

// LI — identifiers: every kept location and every file named in a fold is in the input, in input order per group
{
  const stylishLocs = new Set(stylishRows.map((r) => `${r.file}:${r.line}:${r.col}`));
  const atLineStart = (data) => (loc) => data.split('\n').some((l) => l.startsWith(loc));
  for (const [name, data, has] of [
    ['eslint', ESLINT, (loc) => stylishLocs.has(loc)],
    ['theme-check', THEME, (loc) => atLineStart(THEME)(`[error] ${loc} `) || atLineStart(THEME)(`[warning] ${loc} `) || atLineStart(THEME)(`[suggestion] ${loc} `)],
    ['tsc', TSC, (loc) => atLineStart(TSC)(`${loc}: `)],
  ]) {
    const out = compress({ data }, O).text;
    const locs = locLines(out);
    check(`LI-${name}-some`, locs.length >= 20, String(locs.length));
    const missing = locs.filter((l) => !has(l));
    eq(`LI-${name}-locations-in-input`, missing, []);
    const folded = out.split('\n').filter((l) => l.startsWith('  … ')).flatMap((l) => [...l.matchAll(/(?:\(|, )([^ ,()]+) ×\d+/g)].map((m) => m[1]));
    check(`LI-${name}-fold-files`, folded.length > 0 && folded.every((f) => data.includes(f)), folded.filter((f) => !data.includes(f)).join(' '));
    // Each fold names every file it counts: `… +N in M files (…)` lists M names summing to N.
    const folds = out.split('\n').filter((l) => l.startsWith('  … '));
    check(`LI-${name}-fold-every-file`, folds.every((l) => {
      const m = /^ {2}… \+?([\d,]+) in ([\d,]+) files? \((.*)\)$/.exec(l);
      const parts = [...m[3].matchAll(/ ×(\d+)/g)].map((x) => Number(x[1]));
      return !m[3].includes(' more') && parts.length === Number(m[2]) && parts.reduce((a, b) => a + b, 0) === Number(m[1].replace(/,/g, ''));
    }), folds.join('\n'));
  }
  // Messages that differ only in a quoted name share one group, and each kept location shows its own name.
  const out = compress({ data: TSC }, O).text;
  const g = out.split('\n\n').find((b) => b.startsWith('TS2304 '));
  check('LI-template-group', /^TS2304 \(E \d+\) — Cannot find name '…'\.$/m.test(g), g);
  check('LI-template-names-kept', g.split('\n').slice(1, 6).every((l) => /\) {2}Cannot find name '\w+'\.$/.test(l)), g);
  eq('LI-template', lint.template("'foo' is not defined at /a/b/c.js line 12"), "'…' is not defined at /PATH/c.js line N");
}

// LT — fit: locations per group 5 → 3 → 1 → counts only; still over the target → the caller stubs
{
  const full = compress({ data: ESLINT }, O).text;
  const at = (t) => compress({ data: ESLINT }, { ...O, trace: true, targetBytes: t });
  const r3 = at(bytes(full) - 1);
  eq('LT-files-8', [r3.stats.stages, r3.text.includes('first 5 per group'), /, \+\d+ more\)$/m.test(r3.text)], [['lint', 'files-8'], true, true]);
  check('LT-files-8-fits', r3.stats.bytesOut <= bytes(full) - 1, String(r3.stats.bytesOut));
  const f8 = compress({ data: ESLINT }, { ...O, targetBytes: bytes(r3.text) - 1 });
  check('LT-locs-3', f8.text.includes('first 3 per group'), header(f8.text));
  const r1 = at(7000);
  eq('LT-locs-1', r1.stats.stages, ['lint', 'files-8', 'locs-3', 'locs-1']);
  check('LT-locs-1-fits', r1.stats.bytesOut <= 7000 && groupLines(r1.text).length === groupLines(full).length, String(r1.stats.bytesOut));
  const r0 = at(1024);
  eq('LT-counts', [r0.stats.stages.at(-1), locLines(r0.text).length, r0.text.includes('counts only')], ['counts', 0, true]);
  check('LT-counts-over-target', r0.decision === 'compressed' && r0.stats.bytesOut > 1024, 'a text still over the target comes back for the caller to stub');
  eq('LT-counts-keeps-every-group', groupLines(r0.text), groupLines(full));
}

// LG — guarantees: declines what is not lint, budget, no gain, already slim, deterministic
{
  eq('LG-not-lint', compress({ data: APPLOG }, { ...O, engine: 'lint' }).reason, 'non-lint');
  eq('LG-empty', compress({ data: '   ' }, { ...O, engine: 'lint' }).decision, 'passthrough');
  eq('LG-budget', compress({ data: ESLINT }, { maxMs: -1 }).reason, 'budget-exceeded');
  // 40 problems, each its own rule in its own file: nothing to fold.
  const unique = Array.from({ length: 40 }, (_, i) => `f${i}.js:${i + 1}:1: m${i} [Error/r${i}]`).join('\n');
  eq('LG-no-gain', [sniff({ data: unique }).engine, compress({ data: unique }, O).reason], ['lint', 'no-gain']);
  const out = compress({ data: ESLINT }, O).text;
  check('LG-output-not-lint-again', sniff({ data: out }).engine !== 'lint', sniff({ data: out }).engine);
  check('LG-already-slim', emit.alreadySlim([out], bytes(out), 32768, 's1'), 'the <<slim-lint>> mark is not in MARKS');
  const strip = (r) => ({ ...r, stats: { ...r.stats, ms: 0 } });
  for (const [name, data] of [['eslint', ESLINT], ['theme-check', THEME], ['tsc', TSC]]) {
    eq(`LG-deterministic-${name}`, strip(compress({ data }, { ...O, targetBytes: 4000 })), strip(compress({ data }, { ...O, targetBytes: 4000 })));
  }
  for (const [name, data] of [['random', 'x:1:2: error: y\n'.repeat(5) + '\u0001'.repeat(100)], ['long-line', `a.js:1:1: error: ${'z'.repeat(200000)}`], ['crlf', ESLINT.replace(/\n/g, '\r\n')]]) {
    let threw = null;
    try { compress({ data }, { ...O, engine: 'lint' }); } catch (e) { threw = e; }
    check(`LG-no-throw-${name}`, threw === null, String(threw));
  }
  // Same bytes under any locale: group and file ties order by code unit.
  const ties = compress({ data: TIES }, O).text;
  check('LG-ties-order', /^rule-aa \(E 35\)[^]*^rule-zz \(E 30\)/m.test(ties) && ties.includes('(aa.js ×10, zz.js ×10, äb.js ×10)'), ties);
  const script = `const { compress } = require(${JSON.stringify(path.join(SCRIPTS, 'engines/index.cjs'))}); process.stdout.write(compress({ data: require('fs').readFileSync(0, 'utf8') }, { maxMs: 0 }).text);`;
  for (const loc of ['da_DK.UTF-8', 'sv_SE.UTF-8']) {
    const r = spawnSync('node', ['-e', script], { input: TIES, encoding: 'utf8', env: { PATH: process.env.PATH, LC_ALL: loc, LANG: loc } });
    eq(`LG-ties-locale-${loc}`, r.stdout, ties);
  }
  eq('LG-crlf', compress({ data: ESLINT.replace(/\n/g, '\r\n') }, O).engine, 'lint');
}

// LA — admission: the command words, the gates, the channels
{
  const yes = ['eslint .', 'npx eslint src --ext .js', 'pnpm exec stylelint "**/*.css"', './node_modules/.bin/eslint .', 'cd theme && shopify theme check',
    'theme-check .', 'npx tsc --noEmit', 'yarn tsc -p .', 'prettier --check .', 'npm run lint', 'npm run lint:css', 'pnpm lint', 'yarn lint 2>&1 | tail -200', 'bun run lint'];
  const no = ['cat eslint-report.txt', 'git log --grep eslint', 'grep -rn tsc src', 'npm test', 'echo prettier', 'npm run build'];
  for (const c of yes) check(`LA-cmd-${c}`, ch.LINT_CMD.test(c), c);
  for (const c of no) check(`LA-not-cmd-${c}`, !ch.LINT_CMD.test(c), c);
  eq('LA-admit', [ch.admit('bash', 'lint', 'npx eslint .'), ch.admit('bash', 'lint', 'cat lint.log'), ch.admit('bash', 'lint', 'grep -rn "error:" logs/'), ch.admit('bash', 'lint', 'cat out.txt'),
    ch.admit('mcp', 'lint'), ch.admit('read', 'lint'), ch.admit('attachment', 'lint'), ch.admit('webfetch', 'lint')], ['lint', 'text', 'text', 'text', 'lint', null, null, 'text']);
  eq('LA-admit-read', [ch.admit('read', 'lint', '/w/out/lint.log'), ch.admit('read', 'lint', '/w/out/LINT.NDJSON'), ch.admit('read', 'lint', '/w/x.jsonl'),
    ch.admit('read', 'lint', '/w/report.csv'), ch.admit('read', 'lint', '/w/feed.xml'), ch.admit('read', 'lint', '/w/a.json')], ['lint', 'lint', 'lint', null, null, null]);
  eq('LA-gate', [ch.structuredGate('bash', 'lint', 65536), ch.LINT_GATE], [8192, 8192]);
  eq('LA-registry', REGISTRY.lint, { ext: '.txt', fit: true, stub: true, mcp: true });
}

// LD — delivery through scripts/slim.cjs: Bash by command word, MCP by content, Read of a .log/.jsonl/.ndjson file
{
  const T = realpathSync(mkdtempSync(path.join(tmpdir(), 'slimlint-')));
  const env = { PATH: process.env.PATH, HOME: `${T}/home`, XDG_CONFIG_HOME: `${T}/xdg`, CLAUDE_CONFIG_DIR: `${T}/cfg`, SLIM_DIR: `${T}/spill`, SLIM_DEBUG: '1' };
  const call = (channel, tool, toolInput, response, extra = {}) => {
    const input = JSON.stringify({ v: 1, channel, tool, tool_use_id: 'toolu_lint', tool_input: toolInput, tool_response: response, is_error: false, cwd: T, session_id: 's1' });
    const r = spawnSync('node', [path.join(SCRIPTS, 'slim.cjs')], { cwd: T, env: { ...env, ...extra }, input, encoding: 'utf8' });
    try { return JSON.parse(r.stdout); } catch (_) { return { decision: `bad stdout: ${r.stdout.slice(0, 200)} ${r.stderr.slice(0, 200)}`, record: {} }; }
  };
  const BASH = (stdout) => ({ stdout, stderr: '', interrupted: false, isImage: false });
  const handleOf = (s) => { const m = /<<full=(\S+) original_result>>$/.exec(s); return m ? m[1] : null; };

  const a = call('bash', 'Bash', { command: 'npx eslint src' }, BASH(ESLINT));
  eq('LD-bash-eslint', [a.decision, a.record.engine, a.record.channel], ['compressed', 'lint', 'bash']);
  const out = (a.result || {}).stdout || '';
  check('LD-bash-marker', out.startsWith('<<slim-lint>> stylish · 400 problems'), out.slice(0, 120));
  const h = handleOf(out);
  check('LD-bash-original', !!h && h.endsWith('.txt') && readFileSync(h, 'utf8') === ESLINT, String(h));
  eq('LD-bash-rerun-already-slim', call('bash', 'Bash', { command: 'npx eslint src' }, BASH(out)).reason, 'already-slim');
  eq('LD-bash-theme-check', [call('bash', 'Bash', { command: 'shopify theme check --path theme' }, BASH(THEME)).record.engine], ['lint']);
  eq('LD-bash-not-a-linter', call('bash', 'Bash', { command: 'cat report.txt' }, BASH(ESLINT)).reason, 'plain-gate');
  const g = call('bash', 'Bash', { command: 'grep -rn "error:" logs/' }, BASH(GREP_LOGS));
  check('LD-bash-grep-logs-kept', g.decision !== 'compressed' && g.record.engine !== 'lint', JSON.stringify([g.decision, g.reason, g.record.engine]));
  eq('LD-bash-under-gate', call('bash', 'Bash', { command: 'npx tsc --noEmit' }, BASH(TSC)).reason, 'size-gate');

  const tool = 'mcp__plugin_base_shopify-dev-mcp__validate_theme';
  const m = call('mcp', tool, {}, [{ type: 'text', text: THEME }]);
  eq('LD-mcp-lint', [m.decision, m.record.engine], ['compressed', 'lint']);
  check('LD-mcp-marker', Array.isArray(m.result) && m.result[0].text.startsWith('<<slim-lint>> theme-check · 120 problems'), JSON.stringify(m.result).slice(0, 200));
  const fit = call('mcp', tool, {}, [{ type: 'text', text: ESLINT }], { SLIM_STUB_BYTES: '7000' });
  eq('LD-mcp-fit', [fit.decision, fit.record.engine, fit.record.stages], ['compressed', 'lint', ['lint', 'files-8', 'locs-3', 'locs-1']]);
  const stub = call('mcp', tool, {}, [{ type: 'text', text: ESLINT }], { SLIM_STUB_BYTES: '4096' });
  eq('LD-mcp-stub', [stub.decision, stub.record.engine], ['stubbed', 'stub']);
  eq('LD-mcp-liquid-stays-template', call('mcp', tool, {}, [{ type: 'text', text: THEME_LIQUID }]).reason, 'template');

  mkdirSync(path.join(T, 'out'), { recursive: true });
  const fp = path.join(T, 'out', 'lint.log');
  writeFileSync(fp, ESLINT);
  const readRec = (p, content) => ({ type: 'text', file: { filePath: p, content, numLines: content.split('\n').length, startLine: 1, totalLines: content.split('\n').length } });
  const rd = call('read', 'Read', { file_path: fp }, readRec(fp, ESLINT));
  eq('LD-read-log', [rd.decision, rd.record.engine, rd.record.channel], ['compressed', 'lint', 'read']);
  const rdOut = String(((rd.result || {}).file || {}).content || '');
  check('LD-read-marker', rdOut.startsWith('<<slim-lint>> stylish · 400 problems'), rdOut.slice(0, 120));
  const rh = /<<full=(\S+) original_result>>/.exec(rdOut);
  check('LD-read-original', !!rh && readFileSync(rh[1], 'utf8') === ESLINT, rh ? rh[1] : 'no handle');
  eq('LD-read-under-gate', call('read', 'Read', { file_path: fp }, readRec(fp, TSC)).reason, 'read-guard');
  const txt = path.join(T, 'out', 'lint.txt');
  writeFileSync(txt, ESLINT);
  eq('LD-read-txt-not-admitted', call('read', 'Read', { file_path: txt }, readRec(txt, ESLINT)).reason, 'read-guard');
  rmSync(T, { recursive: true, force: true });
}

console.log(`lint slim fixtures: ${pass} passed, ${fail} failed`);
if (fail) { console.log(failures.join('\n')); process.exitCode = 1; }
