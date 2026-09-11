#!/usr/bin/env node
// Fixture suite for plugins/fnd/scripts/figma-node-slim.cjs — the Figma REST node tree → compact
// markdown build tree compactor that keeps raw REST payloads out of the reader's context.
// Four groups:
//   unit:*      — the formatters, the variables resolver and the filename→file-key rule;
//   tree:*      — rendering one synthetic REST payload per feature (auto-layout, type styles,
//                 bound variables, instances and their props, hidden subtrees, image fills);
//   fold:*      — the sibling fold and its rails, plus the LOSSLESS invariant: every visible input
//                 node id appears in the output on its own line or inside a fold's id list;
//   cli:*       — flags, --out, --stats, EPIPE, and the named exit-2 errors (never a stack trace);
//   size:*      — the exit gate on tests/fixtures/figma-node-rest.json.
// No client payload ships in the repo: every fixture here is synthetic, and the two files under
// tests/fixtures/ that this suite reads are synthetic too (see tests/fixtures/README.md).
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SLIM = path.join(ROOT, 'plugins/fnd/scripts/figma-node-slim.cjs');
const FIX = path.join(ROOT, 'tests/fixtures');
const require = createRequire(import.meta.url);
const S = require(SLIM);
// A renamed or deleted __test export would otherwise surface as a bare TypeError with no row name.
const T = new Proxy(S.__test, { get(o, k) { if (typeof k === 'symbol') return o[k]; if (!(k in o)) throw new Error(`unknown __test export: ${String(k)}`); return o[k]; } });

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; } else { fail++; failures.push(`[${name}] ${detail || ''}`); }
}
const eq = (name, actual, expected) =>
  check(name, JSON.stringify(actual) === JSON.stringify(expected),
    `\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
const has = (name, md, needle) => check(name, md.includes(needle), `output does not contain ${JSON.stringify(needle)}\n--- output ---\n${md}`);
const hasNot = (name, md, needle) => check(name, !md.includes(needle), `output must NOT contain ${JSON.stringify(needle)}\n--- output ---\n${md}`);

const run = (args, opts = {}) => spawnSync(process.execPath, [SLIM, ...args], { encoding: 'utf8', ...opts });

// ------------------------------------------------------------------- module surface --
// Nothing else enumerates what the module publishes; an export added by habit, or one deleted with
// the row that used it, would otherwise leave nothing red.
eq('exports-surface', Object.keys(S).sort(), ['__test', 'compact']);
eq('exports-test-surface', Object.keys(S.__test).sort(),
  ['DEFAULT_MAX_TEXT', 'PROPS_INLINE_MAX', 'bindLabel', 'buildVars', 'effectSummary', 'fine', 'foldDelta',
    'fontLine', 'gradientGeometry', 'hex', 'keyFromName', 'num', 'paintSummary', 'propValue', 'quote',
    'quoteText', 'rleRuns', 'shortVarId', 'sizing', 'skelKey']);

// ------------------------------------------------------------------------------ fixtures --

const VARS = JSON.parse(readFileSync(path.join(FIX, 'figma-variables-local.json'), 'utf8'));
const alias = (id) => ({ type: 'VARIABLE_ALIAS', id });
const solid = (r, g, b, a = 1, extra = {}) => ({ blendMode: 'NORMAL', type: 'SOLID', color: { r, g, b, a }, ...extra });
const box = (x, y, width, height) => ({ x, y, width, height });
const TL = { vertical: 'TOP', horizontal: 'LEFT' };

// One `/v1/files/<key>/nodes` response around a single document.
const payload = (doc, extra = {}) => ({
  name: 'Bundle System',
  role: 'viewer',
  lastModified: '2026-09-01T10:00:00Z',
  editorType: 'figma',
  thumbnailUrl: 'https://example.invalid/thumb.png',
  nodes: { [doc.id]: { document: doc, components: {}, componentSets: {}, schemaVersion: 0, styles: {}, ...extra } },
});

// A card: auto-layout column, padded, bound gap/radius/fill, a shadow, a named fill style, an image
// child, a text child with a text style ref and a bound font size, an instance with overrides, and a
// hidden subtree that must be dropped and counted.
const kitchenSink = () => ({
  id: '10:1',
  name: 'Card / Desktop',
  type: 'FRAME',
  scrollBehavior: 'SCROLLS',
  clipsContent: true,
  absoluteBoundingBox: box(0, 0, 320, 420),
  absoluteRenderBounds: box(-4, -4, 328, 428),
  constraints: { vertical: 'TOP', horizontal: 'LEFT_RIGHT' },
  layoutMode: 'VERTICAL',
  primaryAxisSizingMode: 'AUTO',
  counterAxisSizingMode: 'FIXED',
  primaryAxisAlignItems: 'CENTER',
  counterAxisAlignItems: 'MIN',
  itemSpacing: 12,
  paddingTop: 16, paddingRight: 16, paddingBottom: 24, paddingLeft: 16,
  cornerRadius: 8,
  opacity: 0.9,
  blendMode: 'MULTIPLY',
  minWidth: 280,
  boundVariables: { itemSpacing: alias('VariableID:2:12'), cornerRadius: alias('VariableID:2:13') },
  fills: [solid(1, 1, 1, 1, { boundVariables: { color: alias('VariableID:2:11') } })],
  strokes: [solid(0.9, 0.9, 0.9)],
  strokeWeight: 1,
  strokeAlign: 'INSIDE',
  strokeDashes: [4, 4],
  effects: [{ type: 'DROP_SHADOW', visible: true, color: { r: 0, g: 0, b: 0, a: 0.08 }, blendMode: 'NORMAL', offset: { x: 0, y: 2 }, radius: 8, spread: 1 }],
  styles: { fill: 'S:1' },
  children: [
    {
      id: '10:2',
      name: 'Hero',
      type: 'RECTANGLE',
      absoluteBoundingBox: box(16, 16, 288, 180),
      constraints: TL,
      fills: [{ type: 'IMAGE', scaleMode: 'FILL', imageRef: 'ref-hero-0001' }],
      strokes: [{ type: 'GRADIENT_LINEAR', blendMode: 'NORMAL', gradientStops: [
        { color: { r: 1, g: 0, b: 0, a: 1 }, position: 0 },
        { color: { r: 0, g: 0, b: 1, a: 0.5 }, position: 1 },
      ] }],
      strokeWeight: 2,
      strokeAlign: 'OUTSIDE',
      effects: [],
      layoutGrow: 1,
      layoutAlign: 'STRETCH',
    },
    {
      id: '10:3',
      name: 'Heading',
      type: 'TEXT',
      characters: 'Build your bundle',
      absoluteBoundingBox: box(16, 212, 288, 28),
      constraints: TL,
      fills: [solid(0, 0, 0)],
      strokes: [],
      effects: [],
      styles: { text: 'S:2' },
      style: {
        fontFamily: 'Inter',
        fontPostScriptName: 'Inter-SemiBold',
        fontWeight: 600,
        fontSize: 16,
        lineHeightPx: 24,
        lineHeightUnit: 'PIXELS',
        letterSpacing: 0.2,
        textCase: 'UPPER',
        textDecoration: 'UNDERLINE',
        textAlignHorizontal: 'CENTER',
        textAlignVertical: 'TOP',
        textAutoResize: 'HEIGHT',
      },
      boundVariables: { fontSize: alias('VariableID:2:14') },
      characterStyleOverrides: [0, 0, 1, 1, 1],
      styleOverrideTable: { 1: { fontFamily: 'Inter', fontWeight: 700, fontSize: 16 } },
    },
    {
      id: '10:4',
      name: 'CTA',
      type: 'INSTANCE',
      componentId: 'C:1',
      absoluteBoundingBox: box(16, 252, 288, 48),
      constraints: TL,
      fills: [],
      strokes: [],
      effects: [],
      componentProperties: { 'Label#1:0': { value: 'Add to bundle', type: 'TEXT' }, 'Size#2:0': { value: 'Large', type: 'VARIANT' } },
      overrides: [{ id: '10:5', overriddenFields: ['characters', 'fills'] }],
      children: [
        {
          id: '10:5',
          name: 'Label',
          type: 'TEXT',
          characters: 'Add to bundle',
          absoluteBoundingBox: box(40, 266, 240, 20),
          constraints: TL,
          fills: [solid(1, 1, 1)],
          strokes: [],
          effects: [],
          style: { fontFamily: 'Inter', fontPostScriptName: 'Inter-Regular', fontWeight: 400, fontSize: 14, lineHeightPx: 20, lineHeightUnit: 'PIXELS', textAlignHorizontal: 'CENTER' },
        },
      ],
    },
    {
      id: '10:6',
      name: 'Legacy banner',
      type: 'FRAME',
      visible: false,
      absoluteBoundingBox: box(16, 320, 288, 60),
      constraints: TL,
      fills: [],
      strokes: [],
      effects: [],
      children: [
        { id: '10:7', name: 'Old copy', type: 'TEXT', characters: 'gone', absoluteBoundingBox: box(0, 0, 10, 10), constraints: TL, fills: [], strokes: [], effects: [] },
        { id: '10:8', name: 'Old art', type: 'RECTANGLE', absoluteBoundingBox: box(0, 0, 10, 10), constraints: TL, fills: [], strokes: [], effects: [] },
      ],
    },
  ],
});

const KITCHEN = payload(kitchenSink(), {
  components: { 'C:1': { key: 'ck', name: 'Button / Primary', description: '' } },
  styles: {
    'S:1': { key: 'k1', name: 'Surface/Card', styleType: 'FILL', description: '' },
    'S:2': { key: 'k2', name: 'Heading/Large', styleType: 'TEXT', description: '' },
  },
});

// A row of N cards identical in structure, size, layout and style; only the text, the image ref, the
// ids and the positions differ — the shape the fold exists for.
const card = (i, tweak = {}) => ({
  id: `20:${100 + i}`,
  name: 'Product Card',
  type: 'INSTANCE',
  componentId: 'C:9',
  absoluteBoundingBox: box(i * 320, 0, 300, 380),
  constraints: TL,
  fills: [solid(1, 1, 1)],
  strokes: [],
  effects: [],
  cornerRadius: 8,
  children: [
    {
      id: `20:${200 + i}`, name: 'Image', type: 'RECTANGLE', absoluteBoundingBox: box(i * 320, 0, 300, 240),
      constraints: TL, fills: [{ type: 'IMAGE', scaleMode: 'FILL', imageRef: `ref-${i}` }], strokes: [], effects: [],
    },
    {
      id: `20:${300 + i}`, name: 'Title', type: 'TEXT', characters: `Bundle ${i}`,
      absoluteBoundingBox: box(i * 320, 260, 300, 20), constraints: TL,
      fills: [solid(0, 0, 0)], strokes: [], effects: [],
      style: { fontFamily: 'Inter', fontPostScriptName: 'Inter-Regular', fontWeight: 400, fontSize: 14, lineHeightPx: 20, lineHeightUnit: 'PIXELS' },
      ...tweak,
    },
  ],
});

const row = (cards) => payload({
  id: '20:1',
  name: 'Grid',
  type: 'FRAME',
  absoluteBoundingBox: box(0, 0, 1280, 380),
  constraints: TL,
  layoutMode: 'HORIZONTAL',
  primaryAxisSizingMode: 'FIXED',
  counterAxisSizingMode: 'AUTO',
  itemSpacing: 20,
  fills: [],
  strokes: [],
  effects: [],
  children: cards,
});

// Every visible node id in a REST payload, in document order.
function visibleIds(doc, out = []) {
  if (doc.visible === false) return out;
  out.push(String(doc.id));
  for (const k of doc.children || []) visibleIds(k, out);
  return out;
}
// Every `#id` token the markdown carries — a node line's own id and every id inside a fold list.
const idsIn = (md) => new Set((md.match(/#[0-9A-Za-z]+[:;][0-9A-Za-z:;_-]+/g) || []).map((s) => s.slice(1)));

// ------------------------------------------------------------------------------ unit:* --

eq('unit:num-half-px', ['1440', '12.5', '0', '300', ''], [T.num(1440), T.num(12.4999), T.num(-0.2), T.num(300.00000000000006), T.num('x')]);
eq('unit:fine-keeps-fractions', ['0.2', '-0.5', '1.25', '0'], [T.fine(0.2), T.fine(-0.5), T.fine(1.25), T.fine(-0.001)]);
eq('unit:hex', ['#FFFFFF', '#000000', '#1A3FCC'], [T.hex({ r: 1, g: 1, b: 1 }), T.hex({ r: 0, g: 0, b: 0 }), T.hex({ r: 0.1019607843137255, g: 0.2470588235294118, b: 0.8 })]);
// A name or a text value can never break the one-node-per-line contract.
eq('unit:quote-flattens-control-chars', T.quote('a\nb\tc"d'), '"a\\nb\\tc\\"d"');
eq('unit:quoteText-truncates-and-counts', T.quoteText('abcdefghij', 4), '"abcd" (+6 chars, 10 total)');
eq('unit:quoteText-under-limit-is-whole', T.quoteText('abcd', 4), '"abcd"');
// A SLOT property's value is `{guid:{sessionID,localID}}` — the node that fills the slot. `String()`
// on it is `[object Object]`, which loses the id entirely.
eq('unit:prop-slot-guid-is-a-node-id', T.propValue({ guid: { sessionID: 13938, localID: 520614 } }), '13938:520614');
eq('unit:prop-slot-empty-sentinel', T.propValue({ guid: { sessionID: -1, localID: -1 } }), 'empty');
// Anything else object-shaped still prints its data, verbosely, rather than a placeholder.
eq('unit:prop-object-falls-back-to-json', T.propValue({ a: 1, b: [2, 3] }), '{"a":1,"b":[2,3]}');
eq('unit:prop-partial-guid-is-not-a-node-id', T.propValue({ guid: { sessionID: 1 } }), '{"guid":{"sessionID":1}}');
eq('unit:prop-primitives', ['"Large"', 'false', '3', 'null'],
  [T.propValue('Large'), T.propValue(false), T.propValue(3), T.propValue(null)]);
eq('unit:rle-runs', T.rleRuns([0, 0, 1, 1, 1, 0]), '0-1:0 2-4:1 5:0');
eq('unit:rle-runs-empty', T.rleRuns([]), '');
eq('unit:keyFromName', ['AbC123', '', '', 'k9'],
  [T.keyFromName('/tmp/AbC123-3326-39542.nodes.json'), T.keyFromName('figma-node-rest.json'),
    T.keyFromName('/tmp/notes.json'), T.keyFromName('k9-1_2.nodes.json')]);
// Sizing: the explicit fields win; otherwise the legacy modes and the parent's axis derive it.
eq('unit:sizing-explicit', T.sizing({ layoutSizingHorizontal: 'FILL', layoutSizingVertical: 'HUG' }, null), 'size:fill/hug');
eq('unit:sizing-from-modes', T.sizing({ layoutMode: 'HORIZONTAL', primaryAxisSizingMode: 'FIXED', counterAxisSizingMode: 'AUTO' }, null), 'size:fixed/hug');
eq('unit:sizing-from-parent-axis', T.sizing({ layoutGrow: 1, layoutAlign: 'STRETCH' }, 'HORIZONTAL'), 'size:fill/fill');
eq('unit:sizing-unknown-claims-nothing', T.sizing({ layoutAlign: 'INHERIT', layoutGrow: 0 }, 'HORIZONTAL'), '');

{
  const vars = T.buildVars(VARS);
  eq('unit:vars-collection-prefixed-name', vars.get('VariableID:2:10').name, 'Core/Brand/Primary');
  eq('unit:vars-default-mode-value', vars.get('VariableID:2:10').value, '#1A3FCC');
  // The card surface aliases a primitive: the value a build ships is the primitive's.
  eq('unit:vars-alias-followed', [vars.get('VariableID:2:11').name, vars.get('VariableID:2:11').value], ['Core/Surface/Card', '#FFFFFF']);
  eq('unit:vars-float', vars.get('VariableID:2:12').value, '20');
  eq('unit:vars-no-payload-is-empty', T.buildVars(null).size, 0);
  // A self-referential alias must degrade to a note, never spin.
  const cyc = { meta: { variableCollections: { c: { id: 'c', name: 'C', defaultModeId: 'm', modes: [{ modeId: 'm', name: 'M' }] } },
    variables: { A: { id: 'A', name: 'A', variableCollectionId: 'c', resolvedType: 'COLOR', valuesByMode: { m: { type: 'VARIABLE_ALIAS', id: 'B' } } },
      B: { id: 'B', name: 'B', variableCollectionId: 'c', resolvedType: 'COLOR', valuesByMode: { m: { type: 'VARIABLE_ALIAS', id: 'A' } } } } } };
  eq('unit:vars-alias-cycle-guard', T.buildVars(cyc).get('A').value, '(alias cycle)');
}

{
  // A bound value prints ONCE: the NODE's own value in the parentheses, the variables file supplying
  // the NAME, and `$` marking the binding. These six rows are the whole contract.
  const ctx = { vars: new Map([
    ['VariableID:2:10', { name: 'Core/Brand/Primary', value: '#1A3FCC' }],
    // The real ELC shape: every variable is a LIBRARY variable, so the alias chain leaves this file
    // and `buildVars` can only say "(alias <id>)" — which is not a value and must never be printed.
    ['VariableID:9:9', { name: 'Color Schemes/Text', value: '(alias VariableID:2c10a208c2523fb515cf0aeef76f12c42ddb057c/17282:13579)' }],
  ]) };
  eq('unit:bind-node-value-agrees', T.bindLabel(ctx, 'VariableID:2:10', '#1A3FCC'), '$Core/Brand/Primary (#1A3FCC)');
  // The node wins, and the disagreement is on the line rather than silently resolved either way.
  eq('unit:bind-node-value-differs', T.bindLabel(ctx, 'VariableID:2:10', '#707070'),
    '$Core/Brand/Primary (#707070; var default #1A3FCC)');
  // Chain out of the file: the name is known, the raw `(alias VariableID:…)` never reaches the output.
  eq('unit:bind-alias-leaves-file', T.bindLabel(ctx, 'VariableID:9:9', '#707070'), '$Color Schemes/Text (#707070)');
  // Not in the file at all: the id's tail, never the 40-char library hash.
  eq('unit:bind-unknown-id-is-short', T.bindLabel(ctx, 'VariableID:610bd3cfefdab37e17c6cce7de8a3f71227743fa/21477:389', '#707070'),
    '$var:21477:389 (#707070)');
  // A bound field with no raw counterpart falls back to the variables file's value…
  eq('unit:bind-no-node-value-falls-back', T.bindLabel(ctx, 'VariableID:2:10', ''), '$Core/Brand/Primary (#1A3FCC)');
  // …and with nothing to fall back to, the name alone is the honest answer.
  eq('unit:bind-no-value-anywhere', T.bindLabel(ctx, 'VariableID:9:9', ''), '$Color Schemes/Text');
  eq('unit:shortVarId', ['21477:389', '2:11', 'x'],
    [T.shortVarId('VariableID:610bd3cfefdab37e17c6cce7de8a3f71227743fa/21477:389'),
      T.shortVarId('VariableID:2:11'), T.shortVarId('x')]);
}

// ------------------------------------------------------------------------------ tree:* --

{
  const { md, stats } = S.compact(KITCHEN, { variables: VARS, bytesIn: 10000, fileKey: 'ABC123' });
  has('tree:header-node-and-name', md, '# figma node 10:1 — "Card / Desktop"');
  has('tree:header-file-key', md, 'file: ABC123 · "Bundle System"');
  has('tree:header-last-modified', md, 'lastModified: 2026-09-01T10:00:00Z');
  has('tree:header-hidden-count', md, 'nodes: 5 visible · 3 hidden dropped · 0 folded');
  has('tree:header-tokens-variables', md, 'tokens: variables');
  // auto-layout, padding, alignment, sizing, the bound gap and the bound radius, all on one line
  // The node's own gap is 12 and the variable resolves to 20 — the discrepancy rides the line.
  has('tree:auto-layout', md, 'layout:col gap $Core/Space/Gutter (12; var default 20) pad 16/16/24/16 primary:CENTER');
  has('tree:sizing-derived', md, 'size:fixed/hug');
  has('tree:bound-fill-variable', md, 'fill:$Core/Surface/Card (#FFFFFF)');
  // REST reports that binding twice (on the paint AND on the node); it is named ONCE, with no
  // duplicated `[ … ]` copy of the value behind it.
  hasNot('tree:bound-fill-printed-once', md, '(#FFFFFF) [');
  eq('tree:bound-fill-named-once', (md.match(/Core\/Surface\/Card/g) || []).length, 1);
  has('tree:bound-radius-variable', md, 'radius:$Core/Radius/Card (8)');
  has('tree:stroke-weight-align-dash', md, 'stroke:#E6E6E6 1px INSIDE dash 4,4');
  has('tree:effect-shadow', md, 'shadow:0,2 blur 8 spread 1 #000000 8%');
  has('tree:opacity-and-blend', md, 'opacity:90% blend:MULTIPLY');
  has('tree:min-size', md, 'min-w:280');
  has('tree:clip', md, 'clip');
  has('tree:named-fill-style', md, 'fillStyle:"Surface/Card"');
  has('tree:non-default-constraints-named', md, 'cst:TOP/LEFT_RIGHT');
  // …and the default TOP/LEFT is not repeated 300 times (the legend says so).
  hasNot('tree:default-constraints-elided', md, 'cst:TOP/LEFT ');
  has('tree:image-fill-ref', md, 'fill:image(FILL ref-hero-0001)');
  has('tree:gradient-stroke-summary', md, 'stroke:linear-gradient(#FF0000@0% → #0000FF 50%@100%) 2px OUTSIDE');
  has('tree:child-fill-sizing', md, 'size:fill/fill');
  has('tree:text-characters-inline', md, '"Build your bundle"');
  has('tree:text-style-name', md, 'textStyle:"Heading/Large"');
  has('tree:type-style-table', md, 'type styles:');
  has('tree:bound-font-size', md, '[$Core/Type/Body Size (16)]/24');
  has('tree:typography-details', md, 'ls:0.2 case:UPPER deco:UNDERLINE align:CENTER/TOP autoresize:HEIGHT');
  has('tree:mixed-text-runs', md, 'runs: 0-1:0 2-4:1');
  has('tree:instance-names-its-component', md, '[INSTANCE of "Button / Primary"]');
  has('tree:instance-props', md, 'props:{Label="Add to bundle", Size="Large"}');
  // `overrides` is a per-descendant list of WHICH fields an instance overrode, never the values —
  // and every descendant is walked and printed with its actual values anyway. Dropped by design.
  hasNot('tree:instance-overrides-dropped', md, 'overrides:');
  hasNot('tree:instance-overrides-fields-dropped', md, 'characters,fills');
  hasNot('tree:hidden-subtree-dropped', md, 'Legacy banner');
  hasNot('tree:hidden-child-dropped', md, '#10:7');
  // Vector geometry, render bounds and thumbnails are not buildable data and never appear.
  hasNot('tree:render-bounds-dropped', md, 'absoluteRenderBounds');
  eq('tree:stats-counts', [stats.visible, stats.hidden, stats.folded], [5, 3, 0]);
  // The header states the document's own byte count — it must be exactly right.
  const claimed = /bytes: 10000 → (\d+) \(-([\d.]+)%\)/.exec(md);
  check('tree:header-byte-count-is-a-fixed-point', claimed && Number(claimed[1]) === Buffer.byteLength(md, 'utf8'),
    `header claims ${claimed && claimed[1]}, document is ${Buffer.byteLength(md, 'utf8')} B`);
  eq('tree:stats-bytes-out', stats.bytesOut, Buffer.byteLength(md, 'utf8'));
}

{
  // No variables file (the 403 case on a non-Enterprise plan): the header says so and the bound
  // colour degrades to the id, never to silence.
  const { md } = S.compact(KITCHEN, { bytesIn: 10000 });
  has('tree:no-variables-header', md, 'tokens: raw values (Variables API unavailable on this plan)');
  // No file to name the variable with: the binding still shows, with the node's own value.
  has('tree:no-variables-binding-still-named', md, 'fill:$var:2:11 (#FFFFFF)');
  hasNot('tree:no-variables-no-alias-fragment', md, '(alias ');
  has('tree:no-file-key', md, 'file: (key unknown)');
}

{
  // A payload with two requested nodes gets one section per node.
  const two = payload(kitchenSink());
  two.nodes['20:1'] = { document: row([card(0), card(1)]).nodes['20:1'].document, components: {}, styles: {} };
  const { md } = S.compact(two, { bytesIn: 100 });
  has('tree:multi-node-header', md, '# figma nodes 10:1, 20:1');
  has('tree:multi-node-section-a', md, '## 10:1 "Card / Desktop"');
  has('tree:multi-node-section-b', md, '## 20:1 "Grid"');
}

{
  // A requested node that is itself hidden still produces a document, not a crash.
  const doc = kitchenSink();
  doc.visible = false;
  const { md } = S.compact(payload(doc), { bytesIn: 100 });
  has('tree:requested-node-hidden', md, '(the requested node is hidden — visible:false)');
}

// ------------------------------------------------------------------------------ fold:* --

{
  const p = row([card(0), card(1), card(2), card(3)]);
  const { md, stats } = S.compact(p, { bytesIn: 100 });
  has('fold:exemplar-tagged', md, ' ×4');
  has('fold:block-intro', md, 'folds ×3 (one line per folded sibling');
  // The exemplar keeps its own values; each folded sibling lists its ids and only what differs.
  has('fold:delta-row', md, '#20:101 @320,0 · #20:201 @320,0 img=ref-1 · #20:301 @320,260 "Bundle 1"');
  has('fold:delta-last-row', md, '#20:103 @960,0 · #20:203 @960,0 img=ref-3 · #20:303 @960,260 "Bundle 3"');
  // The card body is printed ONCE.
  eq('fold:exemplar-printed-once', (md.match(/\[INSTANCE\] "Product Card"/g) || []).length, 1);
  eq('fold:stats', [stats.visible, stats.folded], [13, 9]);
  // LOSSLESS: every visible input id is somewhere in the output.
  const want = visibleIds(p.nodes['20:1'].document);
  const got = idsIn(md);
  eq('fold:lossless-every-visible-id-present', want.filter((id) => !got.has(id)), []);
}

{
  // A sibling whose STYLE differs must never be folded into its neighbours — the run breaks around it.
  const different = card(1);
  different.children[1].fills = [{ blendMode: 'NORMAL', type: 'SOLID', color: { r: 1, g: 0, b: 0, a: 1 } }];
  const p = row([card(0), different, card(2)]);
  const { md, stats } = S.compact(p, { bytesIn: 100 });
  eq('fold:different-style-never-folds', stats.folded, 0);
  eq('fold:all-three-cards-printed', (md.match(/\[INSTANCE\] "Product Card"/g) || []).length, 3);
  const want = visibleIds(p.nodes['20:1'].document);
  eq('fold:lossless-with-no-fold', want.filter((id) => !idsIn(md).has(id)), []);
}

{
  // A sibling whose STRUCTURE differs (an extra child) breaks the run the same way…
  const extra = card(2);
  extra.children.push({ id: '20:402', name: 'Badge', type: 'RECTANGLE', absoluteBoundingBox: box(0, 0, 20, 20), constraints: TL, fills: [], strokes: [], effects: [] });
  const p = row([card(0), card(1), extra]);
  const { md, stats } = S.compact(p, { bytesIn: 100 });
  // …so the first two fold and the odd one stands alone.
  has('fold:run-breaks-at-structure-change', md, ' ×2');
  eq('fold:odd-sibling-printed-in-full', (md.match(/\[RECTANGLE\] "Badge"/g) || []).length, 1);
  eq('fold:partial-run-stats', stats.folded, 3);
  const want = visibleIds(p.nodes['20:1'].document);
  eq('fold:lossless-partial-run', want.filter((id) => !idsIn(md).has(id)), []);
}

{
  // A sibling whose SIZE differs is a different node, however identical the rest looks.
  const bigger = card(1);
  bigger.absoluteBoundingBox = box(320, 0, 301, 380);
  const p = row([card(0), bigger]);
  eq('fold:different-size-never-folds', S.compact(p, { bytesIn: 100 }).stats.folded, 0);
}

{
  // Folded text is truncated by --max-text like any other text, and the id list is still complete.
  const long = card(1);
  long.children[1].characters = 'x'.repeat(40);
  const p = row([card(0), long]);
  const { md } = S.compact(p, { bytesIn: 100, maxText: 10 });
  has('fold:delta-text-truncated', md, `"${'x'.repeat(10)}" (+30 chars, 40 total)`);
  has('fold:delta-ids-still-listed', md, '#20:101');
}

{
  // A fold nested INSIDE an exemplar still prints its own fold block (a flat walk skipped it).
  const inner = (i) => ({
    id: `30:${10 + i}`, name: 'Chip', type: 'FRAME', absoluteBoundingBox: box(i * 40, 0, 30, 20),
    constraints: TL, fills: [], strokes: [], effects: [],
    children: [{ id: `30:${50 + i}`, name: 'Label', type: 'TEXT', characters: `c${i}`, absoluteBoundingBox: box(i * 40, 0, 30, 20), constraints: TL, fills: [], strokes: [], effects: [] }],
  });
  const group = (g) => ({
    id: `30:${100 + g}`, name: 'Chips', type: 'FRAME', absoluteBoundingBox: box(0, g * 30, 200, 20),
    constraints: TL, fills: [], strokes: [], effects: [],
    children: [inner(g * 2), inner(g * 2 + 1)],
  });
  const p = payload({ id: '30:1', name: 'Root', type: 'FRAME', absoluteBoundingBox: box(0, 0, 200, 60), constraints: TL, fills: [], strokes: [], effects: [], children: [group(0), group(1)] });
  const { md } = S.compact(p, { bytesIn: 100 });
  eq('fold:nested-fold-blocks', (md.match(/folds ×1 /g) || []).length, 2);
  const want = visibleIds(p.nodes['30:1'].document);
  eq('fold:lossless-nested', want.filter((id) => !idsIn(md).has(id)), []);
}

{
  // The fold key carries `r.fold` itself: a record that already folded its own children stands for
  // a DIFFERENT number of nodes than one that did not. Without it, a one-chip group and a
  // three-identical-chip group reduce to record arrays of equal length and merge — the three-chip
  // group would then be reported as a one-chip group, its `×3` gone, every id still present (so the
  // lossless rows stay green either way). This is the row that goes red when the rail leaves.
  const chip = (id, x) => ({
    id, name: 'Chip', type: 'RECTANGLE', absoluteBoundingBox: box(x, 0, 30, 20),
    constraints: TL, fills: [], strokes: [], effects: [],
  });
  const group = (id, y, kids) => ({
    id, name: 'Group', type: 'FRAME', absoluteBoundingBox: box(0, y, 200, 20),
    constraints: TL, fills: [], strokes: [], effects: [], children: kids,
  });
  const p = payload({
    id: '40:0', name: 'Root', type: 'FRAME', absoluteBoundingBox: box(0, 0, 200, 80),
    constraints: TL, fills: [], strokes: [], effects: [],
    children: [
      group('40:1', 0, [chip('40:11', 0)]),
      group('40:2', 40, [chip('40:21', 0), chip('40:22', 40), chip('40:23', 80)]),
    ],
  });
  const { md, stats } = S.compact(p, { bytesIn: 100 });
  eq('fold:child-count-differs-never-folds', [stats.folded, stats.foldGroups], [2, 1]);
  eq('fold:both-groups-printed', (md.match(/\[FRAME\] "Group"/g) || []).length, 2);
  has('fold:inner-run-still-tagged', md, ' ×3');
  const want = visibleIds(p.nodes['40:0'].document);
  eq('fold:lossless-child-count', want.filter((id) => !idsIn(md).has(id)), []);
}

// ------------------------------------------------------------- paint / stroke / link detail --
// Three things a build cannot be reconstructed without, each of which also has to reach the fold
// key: a gradient's direction, a per-side border, and a text run's link destination.

const rect = (id, x, extra = {}) => ({
  id, name: 'Div', type: 'RECTANGLE', absoluteBoundingBox: box(x, 0, 100, 50),
  constraints: TL, fills: [], strokes: [], effects: [], ...extra,
});
const holder = (kids) => payload({
  id: '50:0', name: 'Holder', type: 'FRAME', absoluteBoundingBox: box(0, 0, 400, 60),
  constraints: TL, fills: [], strokes: [], effects: [], children: kids,
});
const grad = (handles) => ({
  type: 'GRADIENT_LINEAR', blendMode: 'NORMAL',
  gradientHandlePositions: handles,
  gradientStops: [
    { color: { r: 1, g: 0, b: 0, a: 1 }, position: 0 },
    { color: { r: 0, g: 0, b: 1, a: 1 }, position: 1 },
  ],
});
const H_RIGHT = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }];
const H_DOWN = [{ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 0 }];

eq('unit:gradient-to-right', T.gradientGeometry(grad(H_RIGHT)), 'to right 0,0→1,0');
eq('unit:gradient-to-bottom', T.gradientGeometry(grad(H_DOWN)), 'to bottom 0,0→0,1');
eq('unit:gradient-to-left', T.gradientGeometry(grad([{ x: 1, y: 0 }, { x: 0, y: 0 }])), 'to left 1,0→0,0');
eq('unit:gradient-angle-degrees', T.gradientGeometry(grad([{ x: 0, y: 1 }, { x: 1, y: 0 }])), '45deg 0,1→1,0');
eq('unit:gradient-no-handles-no-claim', T.gradientGeometry({ type: 'GRADIENT_LINEAR', gradientStops: [] }), '');
eq('unit:gradient-radial-centre', T.gradientGeometry({
  type: 'GRADIENT_RADIAL', gradientHandlePositions: [{ x: 0.5, y: 0.5 }, { x: 1, y: 0.5 }, { x: 0.5, y: 1 }],
}), 'at 0.5,0.5 [1,0.5 0.5,1]');

{
  // The direction is INSIDE the gradient's own parens, so it travels with the paint — and two
  // banners that differ only in axis are two styles, never one folded exemplar.
  const p = holder([rect('50:1', 0, { fills: [grad(H_RIGHT)] }), rect('50:2', 100, { fills: [grad(H_DOWN)] })]);
  const { md, stats } = S.compact(p, { bytesIn: 100 });
  has('tree:gradient-direction-right', md, 'fill:linear-gradient(to right 0,0→1,0, #FF0000@0% → #0000FF@100%)');
  has('tree:gradient-direction-down', md, 'fill:linear-gradient(to bottom 0,0→0,1, #FF0000@0% → #0000FF@100%)');
  eq('fold:gradient-direction-never-folds', stats.folded, 0);
}

{
  // REST spells per-side borders `individualStrokeWeights`; the Plugin API's `strokeTopWeight`
  // family says the same thing. Both must read as `t/r/b/l px`, and a bottom-only divider must
  // never fold into a sibling that really is a 1 px box.
  const stroke = { strokes: [solid(0, 0, 0)], strokeWeight: 1, strokeAlign: 'CENTER' };
  const divider = rect('50:1', 0, { ...stroke, individualStrokeWeights: { top: 0, right: 0, bottom: 2, left: 0 } });
  const boxed = rect('50:2', 200, stroke);
  const { md, stats } = S.compact(holder([divider, boxed]), { bytesIn: 100 });
  has('tree:stroke-per-side-rest-names', md, 'stroke:#000000 0/0/2/0px CENTER');
  has('tree:stroke-uniform-still-one-number', md, 'stroke:#000000 1px CENTER');
  eq('fold:per-side-stroke-never-folds', stats.folded, 0);
  const plugin = rect('50:3', 0, { ...stroke, strokeTopWeight: 0, strokeRightWeight: 0, strokeBottomWeight: 2, strokeLeftWeight: 0 });
  has('tree:stroke-per-side-plugin-names', S.compact(holder([plugin]), { bytesIn: 100 }).md, 'stroke:#000000 0/0/2/0px CENTER');
}

{
  // A link destination renders as nothing at all, so the PNG cannot recover it; it rides the type
  // style, which is what puts it in the fold key.
  const text = (id, x, style) => ({
    id, name: 'T', type: 'TEXT', characters: 'Contact us', absoluteBoundingBox: box(x, 0, 100, 20),
    constraints: TL, fills: [], strokes: [], effects: [],
    style: { fontFamily: 'Inter', fontSize: 14, lineHeightPx: 20, lineHeightUnit: 'PIXELS', ...style },
  });
  const linked = text('50:1', 0, { hyperlink: { type: 'URL', url: 'https://shop.test/pages/contact' } });
  const { md, stats } = S.compact(holder([linked, text('50:2', 200, {})]), { bytesIn: 100 });
  has('tree:text-hyperlink-url', md, 'link:https://shop.test/pages/contact');
  eq('fold:hyperlink-never-folds', stats.folded, 0);
  has('tree:text-hyperlink-node', S.compact(holder([text('50:3', 0, { hyperlink: { type: 'NODE', nodeID: '9:9' } })]), { bytesIn: 100 }).md,
    'link:node 9:9');
}

// ------------------------------------------------------------- long props on their own line --

{
  // A variant-heavy instance's `props:{…}` runs past the node line it rides on (209 characters on a
  // real page). Past PROPS_INLINE_MAX it moves to an indented continuation line, the shape the
  // per-run style table already uses, so one node still reads as one primary line.
  const inst = (id, props) => ({
    id, name: 'Section', type: 'INSTANCE', componentId: 'C:7', absoluteBoundingBox: box(0, 0, 400, 60),
    constraints: TL, fills: [], strokes: [], effects: [], componentProperties: props,
  });
  const long = {};
  for (let i = 0; i < 8; i++) long[`Property Number ${i}#9:${i}`] = { value: `Value number ${i}`, type: 'VARIANT' };
  const { md } = S.compact(holder([inst('60:1', long), inst('60:2', { 'Size#9:9': { value: 'Large', type: 'VARIANT' } })]), { bytesIn: 100 });
  const lines = md.split('\n');
  const nodeLine = lines.findIndex((l) => l.includes('#60:1'));
  check('props:long-list-leaves-the-node-line', nodeLine !== -1 && !lines[nodeLine].includes('props:{'),
    JSON.stringify(lines[nodeLine]));
  check('props:long-list-is-the-next-indented-line', nodeLine !== -1 && /^ {4}props:\{Property Number 0="Value number 0"/.test(lines[nodeLine + 1] || ''),
    JSON.stringify(lines[nodeLine + 1]));
  // …and a short one stays where it was, inline.
  const shortLine = lines.find((l) => l.includes('#60:2'));
  check('props:short-list-stays-inline', !!shortLine && shortLine.includes('props:{Size="Large"}'), JSON.stringify(shortLine));
  eq('props:inline-max', T.PROPS_INLINE_MAX, 120);
  // The continuation line is part of the fold key like every other tail row: two instances whose
  // props differ are two nodes, however identical the rest of the subtree looks.
  const a = inst('60:3', long);
  const b = inst('60:4', { ...long, 'Property Number 0#9:0': { value: 'Something else entirely', type: 'VARIANT' } });
  eq('props:long-list-still-breaks-the-fold', S.compact(holder([a, b]), { bytesIn: 100 }).stats.folded, 0);
}

{
  // The real page shape: a SLOT property whose value is a guid, a second one left unfilled, and an
  // object value that is neither. None of them may reach the line as `[object Object]`.
  const slots = {
    id: '61:1', name: 'Card Group', type: 'INSTANCE', componentId: 'C:8',
    absoluteBoundingBox: box(0, 0, 400, 60), constraints: TL, fills: [], strokes: [], effects: [],
    componentProperties: {
      'Cards#17793:1338': { type: 'SLOT', value: { guid: { sessionID: 13938, localID: 520614 } }, preferredValues: [] },
      'Cards2#17793:1341': { type: 'SLOT', value: { guid: { sessionID: -1, localID: -1 } }, preferredValues: [] },
      'Meta#17793:1350': { type: 'TEXT', value: { rows: 2 } },
      Viewport: { value: 'Desktop', type: 'VARIANT', boundVariables: {} },
    },
  };
  const { md } = S.compact(holder([slots]), { bytesIn: 100 });
  has('tree:prop-slot-renders-a-node-id', md, 'props:{Cards=13938:520614, Cards2=empty, Meta={"rows":2}, Viewport="Desktop"}');
  hasNot('tree:prop-never-object-object', md, '[object Object]');
}

{
  // The node-level binding with NO paint-level twin (`boundVariables.fills[i]` alone) still names the
  // variable exactly once — the merge must not drop it and must not print it twice.
  const only = rect('60:9', 0, {
    fills: [solid(1, 1, 1)],
    boundVariables: { fills: [alias('VariableID:2:11')] },
  });
  const { md } = S.compact(holder([only]), { bytesIn: 100, variables: VARS });
  has('tree:node-level-binding-alone', md, 'fill:$Core/Surface/Card (#FFFFFF)');
  eq('tree:node-level-binding-not-doubled', (md.match(/Core\/Surface\/Card/g) || []).length, 1);
}

// ------------------------------------------------------------------------------- cli:* --

const NODES_FIXTURE = path.join(FIX, 'figma-node-rest.json');
const VARS_FIXTURE = path.join(FIX, 'figma-variables-local.json');

{
  const r = run([NODES_FIXTURE]);
  eq('cli:stdout-run-exit', r.status, 0);
  check('cli:stdout-carries-the-tree', /^# figma node 3326:39542/.test(r.stdout), r.stdout.slice(0, 120));
  eq('cli:quiet-stderr-without-stats', r.stderr, '');
}

{
  const r = run([NODES_FIXTURE, '--stats']);
  check('cli:stats-line', /^figma-node-slim: 192234 B → \d+ B \(-\d+\.\d%\) nodes=303 hidden=0 folded=\d+\n$/.test(r.stderr), JSON.stringify(r.stderr));
}

{
  const dir = mkdtempSync(path.join(tmpdir(), 'fnslim-'));
  const out = path.join(dir, 'tree.md');
  const r = run([NODES_FIXTURE, '--out', out]);
  const m = /^saved=(\S+) bytes=(\d+)\n$/.exec(r.stdout);
  check('cli:out-prints-saved-line', !!m, JSON.stringify(r.stdout));
  check('cli:out-bytes-match-the-file', m && Number(m[2]) === statSync(out).size, m && `${m[2]} vs ${statSync(out).size}`);
  check('cli:out-path-is-absolute', m && m[1] === out, m && m[1]);
  // --out writes ONE file and creates nothing around it.
  const missing = run([NODES_FIXTURE, '--out', path.join(dir, 'nope', 'tree.md')]);
  eq('cli:out-unwritable-exit', missing.status, 2);
  check('cli:out-unwritable-named', /^figma-node-slim: error=out_unwritable /.test(missing.stderr), JSON.stringify(missing.stderr));
  rmSync(dir, { recursive: true, force: true });
}

{
  const r = run([NODES_FIXTURE, '--max-text', '5']);
  has('cli:max-text-truncates', r.stdout, '"Semi-" (+15 chars, 20 total)');
  // 0 is a real answer — count the characters, print none of them — not a missing value.
  has('cli:max-text-zero-counts-only', run([NODES_FIXTURE, '--max-text', '0']).stdout, '"" (+20 chars, 20 total)');
  const bad = run([NODES_FIXTURE, '--max-text', 'ten']);
  eq('cli:max-text-must-be-a-number', bad.status, 2);
  check('cli:max-text-error-named', /error=usage detail=--max-text/.test(bad.stderr), JSON.stringify(bad.stderr));
}

{
  const r = run([NODES_FIXTURE, '--file-key', 'K3y']);
  has('cli:file-key-flag', r.stdout, 'file: K3y · "Batch-4_ R2.5-Edits"');
  // …and a fixture whose name is not `<key>-<node>.nodes.json` claims no key of its own.
  has('cli:file-key-not-guessed', run([NODES_FIXTURE]).stdout, 'file: (key unknown)');
}

{
  const r = run([NODES_FIXTURE, '--variables', VARS_FIXTURE]);
  has('cli:variables-flag-header', r.stdout, 'tokens: variables');
  eq('cli:variables-flag-exit', r.status, 0);
}

{
  const dir = mkdtempSync(path.join(tmpdir(), 'fnslim-err-'));
  const notJson = path.join(dir, 'x.json');
  writeFileSync(notJson, 'not json at all');
  const wrongShape = path.join(dir, 'y.json');
  writeFileSync(wrongShape, '{"hello":"world"}');
  const emptyNodes = path.join(dir, 'z.json');
  writeFileSync(emptyNodes, '{"nodes":{}}');
  const noDoc = path.join(dir, 'd.json');
  writeFileSync(noDoc, '{"nodes":{"1:2":{}}}');
  const badVars = path.join(dir, 'v.json');
  writeFileSync(badVars, '{oops');
  const cases = [
    ['cli:err-missing-file', [path.join(dir, 'nothing.json')], 'input_unreadable'],
    ['cli:err-invalid-json', [notJson], 'invalid_json'],
    ['cli:err-wrong-shape', [wrongShape], 'not_a_node_response'],
    ['cli:err-empty-nodes', [emptyNodes], 'no_nodes'],
    ['cli:err-no-document', [noDoc], 'node_missing'],
    ['cli:err-bad-variables', [NODES_FIXTURE, '--variables', badVars], 'invalid_variables_json'],
    ['cli:err-missing-variables', [NODES_FIXTURE, '--variables', path.join(dir, 'nope.json')], 'variables_unreadable'],
    ['cli:err-unknown-flag', [NODES_FIXTURE, '--fold'], 'usage'],
    ['cli:err-no-input', [], 'usage'],
  ];
  for (const [name, args, reason] of cases) {
    const r = run(args);
    check(name, r.status === 2 && r.stdout === '' && r.stderr.startsWith(`figma-node-slim: error=${reason}`),
      `status ${r.status} stdout ${JSON.stringify(r.stdout.slice(0, 60))} stderr ${JSON.stringify(r.stderr)}`);
    check(`${name}-no-stack`, !/\n\s+at /.test(r.stderr), `a stack trace reached stderr: ${r.stderr}`);
  }
  rmSync(dir, { recursive: true, force: true });
}

{
  const r = run(['--help']);
  eq('cli:help-exit', r.status, 0);
  check('cli:help-names-the-flags', /--variables .*--out .*--stats.*--max-text/.test(r.stdout), JSON.stringify(r.stdout));
  eq('cli:help-reads-no-input', r.stderr, '');
}

{
  // A downstream `| head -1` closes stdout mid-write: reader-side truncation is success, and the
  // async EPIPE must not surface as a crash after the consumer already has its bytes.
  const r = spawnSync('/bin/sh', ['-c', `${JSON.stringify(process.execPath)} ${JSON.stringify(SLIM)} ${JSON.stringify(NODES_FIXTURE)} | head -1`], { encoding: 'utf8' });
  eq('cli:epipe-quiet-exit', r.status, 0);
  check('cli:epipe-no-stack', !/EPIPE|\n\s+at /.test(r.stderr || ''), JSON.stringify(r.stderr));
}

// ------------------------------------------------------------------------------ size:* --

{
  // The exit gate. The 192 KB synthetic PLP frame holds 303 nodes whose colours drift per card, so
  // NOTHING folds (the rail refuses to merge siblings whose style differs) — losslessness beats the
  // size target, and the gate is the measured value with the plan's 80% floor underneath it.
  const raw = readFileSync(NODES_FIXTURE, 'utf8');
  const { md, stats } = S.compact(JSON.parse(raw), { bytesIn: Buffer.byteLength(raw, 'utf8') });
  const reduction = (1 - stats.bytesOut / stats.bytesIn) * 100;
  check('size:gate-bytes', stats.bytesOut <= 30800, `${stats.bytesOut} B (gate 30800 B)`);
  check('size:gate-reduction', reduction >= 80, `${reduction.toFixed(1)}% (floor 80%)`);
  eq('size:node-count', stats.visible, 303);
  // Lossless on the big fixture too: 303 ids in, 303 ids out.
  const want = visibleIds(JSON.parse(raw).nodes['3326:39542'].document);
  const got = idsIn(md);
  eq('size:lossless-all-303-ids', want.filter((id) => !got.has(id)), []);
  eq('size:no-invented-ids', want.length, 303);
}

console.log(`figma-node-slim fixtures: ${pass} passed, ${fail} failed`);
if (fail) { console.log(failures.join('\n')); process.exit(1); }
