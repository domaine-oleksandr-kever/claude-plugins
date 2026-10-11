#!/usr/bin/env node
// Suite for plugins/slim/scripts/engines/listing.cjs — the listing engine — on the committed listing
// fixtures (find, ls -R, tree, a 50-line git ls-files) and small inputs built inline: sniff (LS),
// decisions and exact bytes (LC), the fit stages (LT), identifier preservation (LI: every printed path
// is in the input, every directory's counts equal the input's), robustness and determinism (LG).
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

const ROOT = realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const require = createRequire(import.meta.url);
const ENGINES = path.join(ROOT, 'plugins/slim/scripts/engines');
const listing = require(path.join(ENGINES, 'listing.cjs'));
const { compress, sniff } = require(path.join(ENGINES, 'index.cjs'));
const { admit, structuredGate, LIST_CMD, LIST_GATE } = require(path.join(ROOT, 'plugins/slim/scripts/delivery/channels.cjs'));
const { alreadySlim } = require(path.join(ROOT, 'plugins/slim/scripts/delivery/emit.cjs'));

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
const fx = (f) => readFileSync(path.join(ROOT, 'tests/fixtures', f), 'utf8');
const O = { maxMs: 0, trace: true };

const FIND = fx('listing-theme-find.txt');
const LSR = fx('listing-node-modules-ls-R.txt');
const TREE = fx('listing-tree.txt');
const SMALL = fx('listing-small.txt');

// LS — sniff
for (const [name, text, reason] of [['find', FIND, 'listing-flat'], ['ls-R', LSR, 'listing-ls-R'], ['tree', TREE, 'listing-tree'], ['small', SMALL, 'listing-flat']]) {
  eq(`LS-${name}`, (({ engine, reason: r }) => [engine, r])(sniff({ data: text })), ['listing', reason]);
}
{
  const hashes = Array.from({ length: 80 }, (_, i) => require('crypto').createHash('sha1').update(String(i)).digest('hex')).join('\n');
  const urls = Array.from({ length: 80 }, (_, i) => `https://shop.example/products/item-${i}.json`).join('\n');
  const lsl = Array.from({ length: 80 }, (_, i) => `-rw-r--r--  1 dev  staff  ${1000 + i} Oct 11 10:00 file-${i}.liquid`).join('\n');
  const short = FIND.split('\n').slice(0, 40).join('\n');
  const words = Array.from({ length: 80 }, (_, i) => `word${i}`).join('\n');
  const csv = Array.from({ length: 401 }, (_, i) => `2026-10-01,SKU-${1000 + i},${(i / 100).toFixed(2)}`).join('\n');
  const emails = Array.from({ length: 80 }, (_, i) => `${i},Bob ${i},bob${i}@shop.example.com`).join('\n');
  const reqs = Array.from({ length: 400 }, (_, i) => `pkg${i}==1.${i}.0`).join('\n');
  const b64 = require('crypto').createHash('sha512').update('seed').digest().toString('base64').repeat(1000).replace(/(.{76})/g, '$1\n').split('\n').slice(0, 60).join('\n');
  const decimals = Array.from({ length: 2000 }, (_, i) => `${i}.${String(i % 100).padStart(2, '0')}`).join('\n');
  const semver = Array.from({ length: 80 }, (_, i) => `react@18.${i}.0`).join('\n');
  const grepC = Array.from({ length: 61 }, (_, i) => `./src/f${i}.js:${i === 37 || i === 50 ? 5 : 0}`).join('\n');
  for (const [name, text] of [['hashes', hashes], ['urls', urls], ['ls-l', lsl], ['under-50-lines', short], ['bare-words', words],
    ['csv', csv], ['csv-emails', emails], ['requirements', reqs], ['base64', b64], ['decimals', decimals], ['semver', semver], ['grep-c', grepC]]) {
    check(`LS-not-${name}`, sniff({ data: text }).engine !== 'listing', JSON.stringify(sniff({ data: text })));
  }
  eq('LS-diff-guard-first', sniff({ data: `diff --git a/x b/x\n--- a/x\n+++ b/x\n${FIND}` }).reason, 'diff');
  eq('LS-template-guard-first', sniff({ data: `{% render 'x' %}\n${FIND}` }).reason, 'template');
  const fenced = `Here are the files:\n\`\`\`\n${FIND.split('\n').slice(0, 300).join('\n')}\n\`\`\``;
  eq('LS-fenced', sniff({ data: fenced }).engine, 'listing');
  eq('LS-export-dir-not-code', sniff({ data: Array.from({ length: 60 }, (_, i) => `export/feeds/feed-${i}.csv`).join('\n') }).engine, 'listing');
}

// LC — decisions and exact bytes
const runs = {};
for (const [name, text, out, stages] of [
  ['find', FIND, 1703, ['listing']],
  ['ls-R', LSR, 32301, ['listing']],
  ['tree', TREE, 1010, ['listing']],
]) {
  const r = compress({ data: text }, O);
  runs[name] = r;
  eq(`LC-${name}`, [r.engine, r.decision, r.stats.bytesIn, r.stats.bytesOut, r.stats.stages], ['listing', 'compressed', bytes(text), out, stages]);
  check(`LC-${name}-marker`, r.text.startsWith('<<slim-listing>> '), r.text.slice(0, 60));
  check(`LC-${name}-footer`, r.text.endsWith("a folded name → rerun narrower (`find <dir> -name '<pattern>'`, `ls <dir>`) or Read the original with offset/limit"), r.text.slice(-120));
  eq(`LC-${name}-spill`, [r.spill.payload === text, r.spill.suggestedName.endsWith('.txt')], [true, true]);
}
eq('LC-find-header', runs.find.text.split('\n')[0], '<<slim-listing>> flat · 2,300 paths · 2,300 files in 17 dirs · 2,274 files folded in 8 dirs · shown 40 lines');
eq('LC-tree-header', runs.tree.text.split('\n').slice(0, 2), ['<<slim-listing>> tree · 473 paths · 464 files in 9 dirs · 452 files folded in 5 dirs · shown 20 lines', '8 directories, 464 files']);
check('LC-find-assets-fold', runs.find.text.includes('\n./assets/ (1,350 files): .js 610, .css 380, .svg 240, .png 90, .woff2 24, .json 6 · e.g. '), runs.find.text.slice(0, 600));
eq('LC-small-no-gain', [compress({ data: SMALL }, O).decision, compress({ data: SMALL }, O).reason], ['passthrough', 'no-gain']);
eq('LC-forced-non-listing', compress({ data: 'hello world\n'.repeat(80) }, { ...O, engine: 'listing' }).reason, 'non-listing');

// LT — fit: the threshold falls 8 → 4 → 0 until targetBytes holds; still over → the caller stubs
{
  const r = compress({ data: LSR }, { ...O, targetBytes: 30000 });
  eq('LT-ls-R-stages', [r.decision, r.stats.stages, r.stats.bytesOut], ['compressed', ['listing', 'fold4', 'fold0'], 19490]);
  check('LT-fold0-no-names', r.text.split('\n').every((l) => !l.startsWith('  ')) && !r.text.includes(' · e.g. '), r.text.slice(0, 400));
  const t = compress({ data: FIND }, { ...O, targetBytes: 1000 });
  eq('LT-find-hist-only', [t.stats.stages, t.stats.bytesOut < 1703], [['listing', 'fold4', 'fold0'], true]);
  eq('LT-find-fits-first', compress({ data: FIND }, { ...O, targetBytes: 32768 }).stats.stages, ['listing']);
  const k = compress({ data: SMALL }, { ...O, targetBytes: 700 });
  eq('LT-small-over-target-folds', [k.decision, k.stats.stages.at(-1), k.stats.bytesOut], ['compressed', 'fold0', 490]);
}

// LI — identifiers: every printed name is a path of the input, every directory's counts equal the input's
function inputModel(text) {
  // A flat listing is its own model: its lines; ls -R and tree go through the engine's parse.
  const p = listing.parse(text);
  const paths = new Set(p.format === 'flat' ? text.split('\n').filter(Boolean) : p.entries.map((e) => e.segs.join('/')));
  const kids = new Map();
  for (const s of paths) {
    const segs = s.split('/');
    for (let i = 0; i < segs.length; i++) {
      const d = segs.slice(0, i).join('/');
      if (!kids.has(d)) kids.set(d, new Set());
      kids.get(d).add(segs.slice(0, i + 1).join('/'));
    }
  }
  return { paths, kids };
}
function outlineOf(text) {
  const dirs = [];
  let cur = null;
  for (const l of text.split('\n').slice(1, -1)) {
    const m = /^(.*?\/|\(top level\)) \((?:([\d,]+) files?(?:, ([\d,]+) dirs?)?|empty)\)(?:: (.*))?$/.exec(l);
    if (m) { cur = { dir: m[1] === '(top level)' ? '' : m[1].slice(0, -1), files: Number((m[2] || '0').replace(/,/g, '')), subdirs: Number((m[3] || '0').replace(/,/g, '')), names: [], folded: !!m[4] }; dirs.push(cur); continue; }
    if (l.startsWith('  ') && cur) cur.names.push(l.slice(2));
  }
  return dirs;
}
for (const [name, text, opts] of [['find', FIND, {}], ['ls-R', LSR, {}], ['tree', TREE, {}], ['ls-R-fold0', LSR, { targetBytes: 30000 }], ['small-fold0', SMALL, { targetBytes: 700 }]]) {
  const r = compress({ data: text }, { ...O, ...opts });
  const { paths, kids } = inputModel(text);
  const dirs = outlineOf(r.text);
  const printed = dirs.flatMap((d) => d.names.map((n) => (d.dir ? `${d.dir}/${n}` : n)));
  check(`LI-${name}-dirs-exist`, dirs.length > 0 && dirs.every((d) => kids.has(d.dir) || paths.has(d.dir)), dirs.filter((d) => !kids.has(d.dir)).map((d) => d.dir).slice(0, 3).join(' '));
  check(`LI-${name}-names-exist`, printed.every((p) => paths.has(p)), printed.filter((p) => !paths.has(p)).slice(0, 3).join(' '));
  const isDir = (p) => kids.has(p);
  const bad = dirs.filter((d) => {
    const ks = [...(kids.get(d.dir) || [])];
    return ks.filter((k) => !isDir(k)).length !== d.files || ks.filter(isDir).length !== d.subdirs || (!d.folded && d.names.length !== d.files);
  });
  check(`LI-${name}-counts`, bad.length === 0, bad.slice(0, 2).map((d) => JSON.stringify(d).slice(0, 200)).join(' | '));
  const total = [...paths].filter((p) => !isDir(p)).length;
  check(`LI-${name}-every-file-accounted`, dirs.reduce((n, d) => n + d.files, 0) === total, `${dirs.reduce((n, d) => n + d.files, 0)} vs ${total}`);
}

// LP — the input shapes the tools print
{
  const bsd = `README.md\nlib\npackage.json\n\n./lib:\n${Array.from({ length: 60 }, (_, i) => `mod-${i}.js`).join('\n')}\n`;
  const b = compress({ data: bsd }, O);
  eq('LP-bsd-ls-R-headerless-first-block', [b.decision, b.text.split('\n').slice(1, 4)], ['compressed', ['./ (2 files, 1 dir)', '  README.md', '  package.json']]);
  const ascii = `.\n${Array.from({ length: 60 }, (_, i) => `|-- page-${i}.liquid`).join('\n')}\n\`-- sub\n    \`-- deep.json\n\n1 directory, 61 files\n`;
  const a = compress({ data: ascii }, O);
  check('LP-tree-ascii', a.decision === 'compressed' && a.text.includes('\n./ (60 files, 1 dir): .liquid 60 · e.g. ') && a.text.includes('\n./sub/ (1 file)\n  deep.json'), a.text);
  const roots = `src\n${Array.from({ length: 30 }, (_, i) => `├── a${i}.ts`).join('\n')}\n└── z.ts\ntest\n${Array.from({ length: 30 }, (_, i) => `├── t${i}.ts`).join('\n')}\n└── z.ts\n\n0 directories, 62 files\n`;
  const t2 = compress({ data: roots }, O);
  check('LP-tree-two-roots', t2.text.includes('\nsrc/ (31 files): ') && t2.text.includes('\ntest/ (31 files): '), t2.text);
  const spaced = `${FIND.split('\n').slice(0, 200).join('\n')}\n./assets/Product Photo 1.png\nfind: './private': Permission denied\n`;
  const s = compress({ data: spaced }, O);
  check('LP-error-line-verbatim', s.text.split('\n')[1] === "find: './private': Permission denied", s.text.split('\n').slice(0, 3).join(' / '));
  check('LP-space-in-name-counted', /\n\.\/assets\/ \(\d+ files\): .*\.png /.test(s.text), s.text.slice(0, 400));
  const abs = Array.from({ length: 60 }, (_, i) => `/Users/dev/shop/sections/s-${i}.liquid`).join('\n');
  eq('LP-absolute', compress({ data: abs }, O).text.split('\n')[1].split(':')[0], '/Users/dev/shop/sections/ (60 files)');
  const priv = `./a:\n${Array.from({ length: 60 }, (_, i) => `f${i}.js`).join('\n')}\n\n./priv:\nls: cannot open directory './priv': Permission denied\n`;
  for (const [name, opts] of [['ls-R-error-verbatim', {}], ['ls-R-error-verbatim-fold0', { targetBytes: 100 }]]) {
    const e = compress({ data: priv }, { ...O, ...opts });
    check(`LP-${name}`, e.text.split('\n')[1] === "ls: cannot open directory './priv': Permission denied" && e.text.includes('\n./priv/ (empty)\n'), e.text);
  }
  const spacedRoot = `a\n${Array.from({ length: 31 }, (_, i) => `├── a${i}.txt`).join('\n')}\n└── last.txt\nMy Dir\n${Array.from({ length: 31 }, (_, i) => `├── b${i}.md`).join('\n')}\n└── blast.md\n\n2 directories, 64 files\n`;
  const sr = compress({ data: spacedRoot }, O);
  check('LP-tree-root-with-space', sr.text.includes('\na/ (32 files): .txt 32 · ') && sr.text.includes('\nMy Dir/ (32 files): .md 32 · e.g. b0.md'), sr.text);
  const fullPaths = (root) => `${root}\n${[0, 1].map((d) => `├── ${root}/d${d}\n${Array.from({ length: 30 }, (_, i) => `│   ├── ${root}/d${d}/f${i}.js`).join('\n')}\n│   └── ${root}/d${d}/sub\n│       └── ${root}/d${d}/sub/deep.js`).join('\n')}\n\n4 directories, 62 files\n`;
  for (const root of ['.', 'src']) {
    const f = compress({ data: fullPaths(root) }, O);
    check(`LP-tree-f-${root}`, f.decision === 'compressed' && f.text.includes(`\n${root}/d0/ (30 files, 1 dir): .js 30 · e.g. f0.js, f1.js, f2.js\n`) && f.text.includes(`\n${root}/d1/sub/ (1 file)\n  deep.js\n`) && !f.text.includes(`${root}/${root}/`), f.text);
  }
  const fdDirs = `${Array.from({ length: 60 }, (_, i) => `blocks/b-${i}.liquid`).join('\n')}\nempty-dir/\n`;
  check('LP-fd-trailing-slash-dir', compress({ data: fdDirs }, O).text.includes('\nempty-dir/ (empty)\n'), compress({ data: fdDirs }, O).text);
}

// LA — admission: Bash by command word only, gate 8,192; never Read, attachment or WebFetch; MCP takes the json route
{
  for (const cmd of ['find . -type f', 'cd theme && find . -name "*.liquid"', 'fd -e liquid', 'ls -R node_modules', 'tree -L 3', 'git ls-files', 'git -C ../shop ls-files', 'rg --files', 'rg -g "*.json" --files', 'find . | sort', 'find . -type f 2>&1 | head -500', '(cd x && find .)']) {
    eq(`LA-bash-${cmd}`, admit('bash', 'listing', cmd), 'listing');
  }
  for (const cmd of ['cat files.txt', 'grep -r foo .', 'echo find', 'node scripts/lsfiles.cjs', 'rg foo', 'git log --stat',
    'ls data && cat data/prices.csv', "find data -name '*.csv' -exec cat {} +", "find data -name '*.csv' -exec cut -d, -f3 {} +",
    'ls && cat requirements.txt', "find src -name '*.js' | xargs grep -c TODO", 'find . -type f; echo done']) {
    eq(`LA-bash-not-${cmd}`, admit('bash', 'listing', cmd), 'text');
  }
  eq('LA-other-channels', ['read', 'attachment', 'webfetch', 'mcp'].map((c) => admit(c, 'listing', 'find .')), [null, null, 'text', 'json']);
  eq('LA-gate', [structuredGate('bash', 'listing', 65536), LIST_GATE], [8192, 8192]);
  check('LA-cmd-segment-start', LIST_CMD.test('make && ls -R') && !LIST_CMD.test('cat ls-output.txt'), String(LIST_CMD));
  const t0 = Date.now();
  LIST_CMD.test(`find ${'2>&1 '.repeat(20000)}&& cat x`);
  check('LA-cmd-linear', Date.now() - t0 < 1000, `${Date.now() - t0} ms`);
}

// LG — robustness: never throws, deterministic, budget, already slim on a re-run
{
  const again = compress({ data: FIND }, O);
  eq('LG-deterministic', [again.text, again.stats.bytesOut], [runs.find.text, runs.find.stats.bytesOut]);
  // Input order is kept: `ls -t` shows its newest files first, in the full list and in the examples.
  const newest = Array.from({ length: 60 }, (_, i) => `run-${String(59 - i).padStart(2, '0')}.log`);
  eq('LG-input-order-examples', compress({ data: newest.join('\n') }, O).text.split('\n')[1], '(top level) (60 files): .log 60 · e.g. run-59.log, run-58.log, run-57.log');
  const few = `${newest.slice(0, 6).map((n) => `logs/${n}`).join('\n')}\n${FIND}`;
  check('LG-input-order-full', compress({ data: few }, O).text.includes('\nlogs/ (6 files)\n  run-59.log\n  run-58.log\n'), compress({ data: few }, O).text.slice(0, 300));
  eq('LG-budget', compress({ data: FIND }, { maxMs: -1 }).reason, 'budget-exceeded');
  eq('LG-budget-run', listing.run(FIND, {}, { deadline: Date.now() - 1 }).reason, 'budget-exceeded');
  for (const [name, junk] of [['empty', ''], ['glyphs-only', '├── \n'.repeat(80)], ['orphan-branch', `│   ├── x\n${'├── a.js\n'.repeat(60)}`], ['slashes', '/\n'.repeat(80)], ['nul-free-binaryish', '\u0001\u0002/\u0003\n'.repeat(80)]]) {
    let ok = true;
    try { const r = listing.run(junk, {}, { deadline: null }); ok = typeof r.decision === 'string'; } catch (_) { ok = false; }
    check(`LG-no-throw-${name}`, ok, name);
  }
  eq('LG-rerun-not-a-listing', sniff({ data: runs.find.text }).engine === 'listing', false);
  check('LG-already-slim-mark', alreadySlim([runs.tree.text], bytes(runs.tree.text), 33968, 's1'), 'MARKS lacks <<slim-listing>>');
}

console.log(`listing fixtures: ${pass} passed, ${fail} failed`);
if (fail) { console.log(failures.join('\n')); process.exitCode = 1; }
