#!/usr/bin/env node
// Suite for plugins/slim/scripts/engines/a11y.cjs — browser accessibility snapshots with their repeated
// siblings folded — on the tests/fixtures/a11y-*.txt snapshots (generator:
// plugins/slim/evals/_shared/make-a11y.cjs) and playwright-snapshot.txt. Rows: AS sniff, AC compress
// (decision, exact bytes, header, footer), AI identifier preservation (every ref kept, in order, or in a
// fold / cut range / the dropped-img line; folded names listed up to the cap), AT fit stages under
// targetBytes, AG guarantees (deterministic, already slim, budget, never throws), AF the generator,
// AR the registry row and channel admission.
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { readFileSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const ROOT = realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const require = createRequire(import.meta.url);
const SCRIPTS = path.join(ROOT, 'plugins/slim/scripts');
const a11y = require(path.join(SCRIPTS, 'engines/a11y.cjs'));
const { compress, sniff, REGISTRY } = require(path.join(SCRIPTS, 'engines/index.cjs'));
const ch = require(path.join(SCRIPTS, 'delivery/channels.cjs'));
const FIX = path.join(ROOT, 'tests/fixtures');

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
const O = { maxMs: 0, trace: true };

const FIXTURES = {
  plp: fx('a11y-plp.txt'),
  'plp-devtools': fx('a11y-plp-devtools.txt'),
  pdp: fx('a11y-pdp.txt'),
  cart: fx('a11y-cart.txt'),
  docs: fx('a11y-docs.txt'),
  grid: fx('playwright-snapshot.txt'),
};
const FORMAT = { plp: 'playwright', 'plp-devtools': 'devtools', pdp: 'playwright', cart: 'playwright', docs: 'playwright', grid: 'playwright' };

// Every ref an input carries, in document order.
const inputRefs = (t, format) => (format === 'devtools'
  ? [...t.matchAll(/^\s*uid=(\S+)/gm)].map((m) => m[1])
  : [...t.matchAll(/\[ref=([^\]\s]+)\]/g)].map((m) => m[1]));
// `e5–e9, e12` → every id it names.
function expand(list) {
  const out = [];
  for (const part of list.split(', ')) {
    const [a, b] = part.split('–');
    if (!b) { out.push(a); continue; }
    const [, p, x] = /^(.*?)(\d+)$/.exec(a);
    const y = Number(/(\d+)$/.exec(b)[1]);
    for (let n = Number(x); n <= y; n++) out.push(`${p}${n}`);
  }
  return out;
}
// The output's refs: on kept lines (in order), inside fold / cut lines, and on the dropped-img line.
function outputRefs(t, format) {
  const kept = [];
  const folded = [];
  for (const line of t.split('\n')) {
    const fold = /^\s*(?:- )?… .*?\[(?:refs|uids) ([^\]]+)\]/.exec(line);
    const drop = /^unnamed imgs dropped: (?:refs|uids) (.+)$/.exec(line);
    if (fold) folded.push(...expand(fold[1]));
    else if (drop) folded.push(...expand(drop[1]));
    else kept.push(...inputRefs(line, format));
  }
  return { kept, folded };
}
const isSubsequence = (sub, all) => { let i = 0; for (const x of all) if (x === sub[i]) i++; return i === sub.length; };

// AS — sniff
for (const [k, t] of Object.entries(FIXTURES)) eq(`AS-${k}`, [sniff({ data: t }).engine, sniff({ data: t }).reason], ['a11y', FORMAT[k]]);
{
  const tree = FIXTURES.grid.slice(FIXTURES.grid.indexOf('```yaml\n') + 8, FIXTURES.grid.lastIndexOf('```'));
  // An action result: code fence, page state, then the snapshot fence — no fence dominates.
  const action = `### Ran Playwright code\n\`\`\`js\nawait page.getByRole('link', { name: 'Shop' }).click();\n\`\`\`\n### Page state\n- Page URL: https://shop.example.invalid/collections/shop\n- Page Snapshot:\n\`\`\`yaml\n${tree}\`\`\`\n`;
  eq('AS-action-result', sniff({ data: action }).engine, 'a11y');
  const r = compress({ data: action }, O);
  check('AS-action-result-prefix', r.decision === 'compressed' && r.text.split('\n').slice(1, 5).join('\n') === action.split('\n').slice(0, 4).join('\n'), r.text.slice(0, 300));
  // The guards stay ahead: Liquid in the page text is template text, a diff is a diff.
  eq('AS-template-guard', sniff({ data: `${tree}  - paragraph [ref=e999]: {% render 'card' %}\n` }).reason, 'template');
  eq('AS-diff-guard', sniff({ data: `diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n${tree}` }).reason, 'diff');
  // A markdown list of lowercase words has no refs: not a snapshot.
  const bullets = Array.from({ length: 40 }, (_, i) => `- item${i}: note`).join('\n');
  check('AS-bullets-not-a11y', sniff({ data: bullets }).engine !== 'a11y', sniff({ data: bullets }).engine);
  // Under 20 tree lines: not claimed.
  eq('AS-short', a11y.detectSnapshot(tree.split('\n').slice(0, 15).join('\n')), null);
  check('AS-log-stays-log', sniff({ data: fx('app.log') }).engine === 'log', sniff({ data: fx('app.log') }).engine);
}

// AC — compress: decision, exact bytes, header, footer
const TABLE = {
  plp: [23230, 9081], 'plp-devtools': [24308, 9633], pdp: [13048, 9423], cart: [6215, 2801], grid: [20722, 2857],
};
const OUT = {};
for (const [k, [inB, outB]] of Object.entries(TABLE)) {
  const t = FIXTURES[k];
  const r = compress({ data: t }, O);
  OUT[k] = r;
  eq(`AC-${k}-decision`, [r.decision, r.engine, r.stats.stages], ['compressed', 'a11y', ['fold']]);
  eq(`AC-${k}-bytes`, [r.stats.bytesIn, r.stats.bytesOut], [inB, outB]);
  const head = r.text.split('\n')[0];
  check(`AC-${k}-header`, new RegExp(`^<<slim-a11y>> ${FORMAT[k]} · [\\d,]+ nodes → [\\d,]+ lines · \\d+ folds? \\([\\d,]+ nodes\\)`).test(head), head);
  const nodes = Number(/· ([\d,]+) nodes →/.exec(head)[1].replace(/,/g, ''));
  eq(`AC-${k}-node-count`, nodes, FORMAT[k] === 'devtools' ? inputRefs(t, 'devtools').length : t.split('\n').filter((l) => /^\s*- [a-z]/.test(l)).length);
  const foot = r.text.split('\n').pop();
  check(`AC-${k}-footer`, foot.startsWith('slim a11y: a ref inside a fold is still live') && foot.includes('mcp__slim__lookup({ path: ') &&
    foot.includes(FORMAT[k] === 'devtools' ? 'take_snapshot({ verbose: true })' : 'browser_find'), foot);
  eq(`AC-${k}-spill`, [r.spill.kind, r.spill.payload === t, r.spill.suggestedName.endsWith('.txt')], ['original', true, true]);
  eq(`AC-${k}-meta-format`, r.meta && r.meta.format, FORMAT[k]);
}
{
  const r = compress({ data: FIXTURES.docs }, O);
  eq('AC-docs-prose-no-gain', [r.decision, r.engine, r.reason, r.text === FIXTURES.docs], ['passthrough', 'a11y', 'no-gain', true]);
  const g = OUT.grid.text;
  check('AC-grid-fold-line', g.includes('- … 46 more like the 2 above [refs e40–e361]: names "Cleanser No. 3", "Toner No. 4"') && g.includes(' … +34; prices $22.00–$112.00'), g);
  // Prose and long items never fold: every review of the PDP stays, a landmark is never folded.
  const p = OUT.pdp.text;
  check('AC-pdp-reviews-kept', Array.from({ length: 10 }, (_, i) => `heading "Calm skin, week ${i + 2}"`).every((h) => p.includes(h)), 'a review was folded');
  check('AC-pdp-state-kept', ['radio "30 ml" [checked]', 'radio "100 ml" [disabled]', 'button "Description" [expanded]', 'radio "Shade 03" [checked]'].every((s) => p.includes(s)), 'a state attr was lost');
  check('AC-plp-sold-out-kept', (OUT.plp.text.match(/Sold out/g) || []).length === 3, 'a sold-out card was folded into its neighbours');
  // A nameless leaf img goes; the gallery button that held one loses its trailing colon.
  check('AC-pdp-img-dropped', !/- img \[ref=/.test(p) && p.includes('- button "Show image 2 of 8" [ref=e36] [cursor=pointer]\n'), 'unnamed img kept');
  // Five identical alert items never fold; nor does a run of plain paragraphs.
  const alerts = ['```yaml', '- main [ref=e1]:', '  - list [ref=e2]:'];
  for (let i = 0; i < 30; i++) alerts.push(`    - listitem [ref=e${3 + i * 3}]:`, `      - alert [ref=e${4 + i * 3}]: Item ${i} is low on stock`, `      - button "Dismiss ${i}" [ref=e${5 + i * 3}]`);
  alerts.push('```');
  const al = compress({ data: alerts.join('\n') }, O);
  eq('AC-alerts-not-folded', [al.engine, al.decision, al.reason], ['a11y', 'passthrough', 'no-gain']);
  // A table's rows fold though no row holds a control; names are cut at 60 chars.
  const table = ['- table [ref=e1]:', '  - rowgroup [ref=e2]:'];
  for (let i = 0, n = 3; i < 100; i++) {
    table.push(`    - row "Order #${1000 + i} Paid $${i}.00${i === 5 ? ` ${'note '.repeat(20)}` : ''}" [ref=e${n++}]:`);
    for (const c of [`Order #${1000 + i}`, 'Paid', `$${i}.00`]) table.push(`      - cell "${c}" [ref=e${n++}]`);
  }
  const tb = a11y.run(table.join('\n'), {}, {});
  check('AC-table-rows-fold', tb.decision === 'compressed' && tb.meta.folds === 1 && tb.text.includes('- … 98 more like the 2 above [refs e11–e402]: names "Order #1002 Paid $2.00"') &&
    tb.text.includes(`"Order #1005 Paid $5.00 ${'note '.repeat(6)}note…"`) && tb.text.includes('… +86; prices $2.00–$99.00'), tb.text.slice(0, 1200));
  // A run ends at the first sibling over the text cap: a short first review never folds the long ones.
  const reviews = ['- list [ref=e1]:'];
  for (let i = 0; i < 30; i++) reviews.push(`  - listitem [ref=e${2 + i * 3}]:`, `    - paragraph [ref=e${3 + i * 3}]: ${i ? `Review ${i} ${'long text '.repeat(40)}` : 'Great.'}`, `    - button "Helpful" [ref=e${4 + i * 3}]`);
  const rv = a11y.run(reviews.join('\n'), {}, {});
  eq('AC-short-first-review-no-fold', [rv.decision, rv.reason], ['passthrough', 'no-gain']);
  // A run of three with k=2 folds its third when the fold line is the smaller (the PDP's related products).
  check('AC-three-fold-one', OUT.pdp.text.includes('- … 1 more like the 2 above [refs e28]: names "Serum No. 1"'), OUT.pdp.text);
}

// AI — identifier preservation
for (const [k, r] of Object.entries(OUT)) {
  const want = inputRefs(FIXTURES[k], FORMAT[k]);
  const { kept, folded } = outputRefs(r.text, FORMAT[k]);
  check(`AI-${k}-kept-in-order`, isSubsequence(kept, want), kept.slice(0, 20).join(' '));
  eq(`AI-${k}-every-ref-once`, [...kept, ...folded].sort(), want.slice().sort());
  const input = new Set(FIXTURES[k].split('\n').map((l) => l.trim()));
  const body = r.text.split('\n').slice(1, -1).filter((l) => l && !/^\s*(?:- )?… /.test(l) && !l.startsWith('unnamed imgs dropped:'));
  check(`AI-${k}-lines-verbatim`, body.every((l) => input.has(l.trim()) || input.has(`${l.trim()}:`)), body.find((l) => !input.has(l.trim()) && !input.has(`${l.trim()}:`)));
  // Every fold lists its items' names up to the cap of 12 and counts the rest.
  for (const line of r.text.split('\n').filter((l) => / more like the /.test(l))) {
    const n = Number(/… (\d+) more like/.exec(line)[1]);
    const shown = (/: names (.*?)(?: … \+\d+)?(?:; prices? .*)?$/.exec(line) || [, ''])[1].match(/"(?:[^"\\]|\\.)*"/g) || [];
    const more = Number((/ … \+(\d+)/.exec(line) || [, 0])[1]);
    check(`AI-${k}-fold-names`, shown.length === Math.min(n, 12) && shown.length + more === n, line);
  }
}

// AI — a tree the parser cannot read whole keeps every node under its own parent
{
  // DevTools: a StaticText name with a raw newline splits the tree; `list` stays a child of `main`.
  const dt = ['uid=1_0 RootWebArea "Shop"', '  uid=1_1 main', '    uid=1_2 code', '      uid=1_3 StaticText "line one', 'line two"', '    uid=1_4 list'];
  for (let i = 0; i < 20; i++) dt.push(`      uid=1_${5 + i * 2} listitem`, `        uid=1_${6 + i * 2} link "Product ${i}"`);
  dt.push('  uid=1_65 contentinfo');
  const d = a11y.run(dt.join('\n'), {}, {});
  check('AI-split-devtools-nesting', d.decision === 'compressed' && d.text.includes('line two"\n    uid=1_4 list\n      uid=1_5 listitem\n') && d.text.includes('\n  uid=1_65 contentinfo\n'), d.text);
  // Playwright: a stray line inside a list keeps the listitems under the list, beside nothing else.
  const pw = ['- main [ref=e1]:', '  - list [ref=e2]:'];
  for (let i = 0; i < 20; i++) { pw.push(`    - listitem [ref=e${10 + i * 2}]:`, `      - link "Product ${i}" [ref=e${11 + i * 2}]`); if (i === 9) pw.push('stray note'); }
  pw.push('  - button "Load more" [ref=e99]');
  const p = a11y.run(pw.join('\n'), {}, {});
  check('AI-split-playwright-nesting', p.decision === 'compressed' && p.text.includes('stray note\n    - listitem [ref=e30]:\n      - link "Product 10" [ref=e31]\n') &&
    p.text.includes('\n  - button "Load more" [ref=e99]\n'), p.text);
  // A key Playwright YAML-quotes for its `: `: parsed, kept quoted with its colon, its child under it, the run unbroken.
  const q = ['- main [ref=e1]:', '  - list [ref=e2]:'];
  for (let i = 0; i < 20; i++) {
    const link = i === 0 ? `'link "Size: ${i}" [ref=e${11 + i * 3}]'` : i === 5 ? `'link "It''s: ${i}" [ref=e${11 + i * 3}]'` : `link "Size ${i}" [ref=e${11 + i * 3}]`;
    q.push(`    - listitem [ref=e${10 + i * 3}]:`, `      - ${link}:`, `        - /url: /p/${i}`);
  }
  const qt = q.join('\n');
  eq('AI-quoted-sniff', a11y.detectSnapshot(qt), 'playwright');
  const qr = a11y.run(qt, {}, {});
  check('AI-quoted-kept', qr.decision === 'compressed' && qr.meta.folds === 1 && qr.text.includes(`    - listitem [ref=e10]:\n      - 'link "Size: 0" [ref=e11]':\n        - /url: /p/0\n`) &&
    qr.text.includes('"It\'s: 5"'), qr.text);
  const { kept, folded } = outputRefs(qr.text, 'playwright');
  eq('AI-quoted-every-ref-once', [...kept, ...folded], inputRefs(qt, 'playwright'));
  const fold1 = a11y.run(qt, { targetBytes: bytes(qr.text) - 1 }, {});
  const qp = a11y.run(qt, { targetBytes: bytes(fold1.text) - 1 }, {});
  eq('AI-quoted-prune-stage', qp.stages, ['fold', 'fold1', 'prune']);
  check('AI-quoted-prune-requoted', qp.text.includes(`      - 'link "Size: 0" [ref=e11]'\n`), qp.text);
}

// AT — fit: the named stages reach a 4 KB target, refs still all there
for (const [k, stages] of [['plp', ['fold', 'fold1', 'prune', 'depth']], ['plp-devtools', ['fold', 'fold1', 'prune', 'depth']], ['pdp', ['fold', 'fold1', 'prune', 'depth']], ['cart', ['fold']]]) {
  const r = compress({ data: FIXTURES[k] }, { ...O, targetBytes: 4096 });
  eq(`AT-${k}-stages`, [r.decision, r.stats.stages], ['compressed', stages]);
  check(`AT-${k}-under-4k`, r.stats.bytesOut <= 4096, String(r.stats.bytesOut));
  const { kept, folded } = outputRefs(r.text, FORMAT[k]);
  eq(`AT-${k}-every-ref-once`, [...kept, ...folded].sort(), inputRefs(FIXTURES[k], FORMAT[k]).sort());
}
{
  const r = compress({ data: FIXTURES.grid }, { ...O, targetBytes: 2600 });
  eq('AT-fold1', r.stats.stages, ['fold', 'fold1']);
  check('AT-fold1-names-cap-6', r.text.includes('… 47 more like the one above [refs e33–e361]: names "Cream No. 2", ') && / … \+41; prices/.test(r.text), r.text);
  const pr = compress({ data: FIXTURES.plp }, { ...O, targetBytes: 6000 });
  eq('AT-prune', pr.stats.stages, ['fold', 'fold1', 'prune']);
  check('AT-prune-state-only', !pr.text.includes('[cursor=pointer]') && !pr.text.includes('/url:') && pr.text.includes('checkbox "In stock" [checked] [ref=e27]'), pr.text.slice(0, 1500));
  // A target nothing reaches: the last depth stage is returned for the caller to stub.
  const tiny = compress({ data: FIXTURES.plp }, { ...O, targetBytes: 200 });
  // A cut lists the names inside the subtree, not only each child's first.
  const cart = compress({ data: FIXTURES.cart }, { ...O, targetBytes: 1500 }).text;
  check('AT-cut-names-deep', /navigation "Main".*\n\s+- … \d+ nodes below \[refs [^\]]+\]: names "Shop", "Skincare", /.test(cart), cart.slice(0, 1500));
  check('AT-unreachable', tiny.decision === 'compressed' && tiny.stats.stages.includes('depth') && tiny.stats.bytesOut > 200 && tiny.stats.bytesOut < 4096, `${tiny.decision} ${tiny.stats.bytesOut}`);
}

// AG — guarantees
for (const [k, t] of Object.entries(FIXTURES)) {
  const a = compress({ data: t }, { ...O, targetBytes: 5000 });
  const b = compress({ data: t }, { ...O, targetBytes: 5000 });
  eq(`AG-${k}-deterministic`, a.text === b.text && a.decision === b.decision, true);
}
{
  const out = OUT.plp.text;
  eq('AG-rerun-not-sniffed', sniff({ data: out }).engine === 'a11y', false);
  eq('AG-rerun-forced', [compress({ data: out }, { ...O, engine: 'a11y' }).decision, compress({ data: out }, { ...O, engine: 'a11y' }).reason], ['passthrough', 'non-a11y']);
  eq('AG-budget', compress({ data: FIXTURES.plp }, { maxMs: -1 }).reason, 'budget-exceeded');
  eq('AG-run-budget', a11y.run(FIXTURES.plp, {}, { deadline: Date.now() - 1 }).reason, 'budget-exceeded');
  const garbage = [
    '', '-', '- \n- \n'.repeat(30), `${'  '.repeat(400)}- generic [ref=e1]:\n`.repeat(30),
    Array.from({ length: 60 }, (_, i) => `${' '.repeat((i * 7) % 13)}- link "x${i}" [ref=e${i}]:`).join('\n'),
    Array.from({ length: 60 }, (_, i) => `uid=${i} ${'StaticText'} "${'"'.repeat(i % 3)}`).join('\n'),
    `- button "${'a'.repeat(200000)}" [ref=e1]\n`.repeat(25),
  ];
  // Shapes past the stack: a 130k-child wrapper, 3,000 levels, a 10 MB name. None ends in transform-error.
  const wide = ['- main [ref=e1]:', '  - generic:', ...Array.from({ length: 130000 }, (_, i) => `    - button "B" [ref=e${i + 2}]`)].join('\n');
  const deep = Array.from({ length: 3000 }, (_, i) => `${'  '.repeat(i)}- group [ref=e${i}]:`).join('\n');
  const huge = `- button "${'a'.repeat(10 * 1024 * 1024)}" [ref=e1]\n${Array.from({ length: 30 }, (_, i) => `- link "l${i}" [ref=e${i + 2}]`).join('\n')}`;
  const big = (t) => compress({ data: t }, { ...O, maxInputBytes: 64 * 1024 * 1024 });
  eq('AG-wide-wrapper', [big(wide).decision, big(wide).reason], ['compressed', undefined]);
  eq('AG-too-deep', [big(deep).decision, big(deep).reason], ['passthrough', 'non-a11y']);
  check('AG-huge-name', big(huge).reason !== 'transform-error', big(huge).reason);
  for (const [i, g] of garbage.entries()) {
    let ok = true;
    try { const r = a11y.run(g, { targetBytes: 1000 }, { deadline: null }); ok = typeof r.decision === 'string'; } catch (_) { ok = false; }
    check(`AG-no-throw-${i}`, ok, g.slice(0, 60));
  }
}

// AF — the committed fixtures are the generator's output
for (const [k, f] of [['plp', 'a11y-plp.txt'], ['plp-devtools', 'a11y-plp-devtools.txt'], ['pdp', 'a11y-pdp.txt'], ['cart', 'a11y-cart.txt'], ['docs', 'a11y-docs.txt']]) {
  const g = spawnSync('node', [path.join(ROOT, 'plugins/slim/evals/_shared/make-a11y.cjs'), k], { encoding: 'utf8' }).stdout;
  eq(`AF-${k}`, g === fx(f), true);
}

// AR — the registry row and where the engine may run
eq('AR-flags', REGISTRY.a11y, { ext: '.txt', fit: true, stub: true, mcp: true });
eq('AR-admit', ['mcp', 'bash', 'read', 'attachment', 'webfetch'].map((c) => ch.admit(c, 'a11y', 'cat snapshot.txt')), ['a11y', 'text', null, null, 'text']);

console.log(`a11y slim fixtures: ${pass} passed, ${fail} failed`);
for (const f of failures) console.log(f);
process.exitCode = fail ? 1 : 0;
