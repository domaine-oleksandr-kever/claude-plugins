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
  plp: [23230, 9081], 'plp-devtools': [24308, 9633], pdp: [13048, 9447], cart: [6215, 2801], grid: [20722, 2857],
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
