#!/usr/bin/env node
/*
 * figma-node-slim.cjs — Figma REST node tree → compact markdown build tree.
 *
 * WHY a script: `figma-rest.sh` saves the raw `/v1/files/<key>/nodes` response, and one frame is
 * 200–280 KB of JSON (a page is ~1 MB). None of that may enter the model's context. This turns the
 * payload into a build tree a reader can `Read` in one or two calls — LOSSLESS FOR BUILD-RELEVANT
 * DATA: every visible node keeps its measurements, layout, colours, typography and effects, and
 * every visible node id appears in the output either on its own line or inside a fold's id list.
 *
 * What it deliberately drops (the PNG next to the payload is the visual ground truth, and none of
 * this is buildable data): `fillGeometry` / `strokeGeometry` vector paths, `absoluteRenderBounds`
 * (a duplicate of the bounding box after effects), `exportSettings`, `scrollBehavior`, `locked`,
 * `layoutVersion`, thumbnails, the instance `overrides` array — plus `visible:false` subtrees, which
 * are counted in the header.
 *
 * `overrides` is the one that looks buildable and is not: it is a per-descendant list of WHICH fields
 * an instance overrode, never the values. Every descendant is walked and printed with its actual
 * values anyway, so the array restates the tree in ids and field names — on a real page it was 51% of
 * the whole output. `componentProperties` (`props:{…}`) is a different thing and stays: it is the
 * instance's variant/text properties, with their values, and nothing else carries them.
 *
 * USAGE
 *   node figma-node-slim.cjs <nodes.json> [--variables <variables.json>] [--out <file.md>]
 *                            [--stats] [--max-text <N>] [--file-key <key>]
 *   --variables  the `/v1/variables/local` payload: it NAMES the `boundVariables` ids, so a bound
 *                value reads `$Collection/Group/Name (<node value>)` — the node's own value stays the
 *                render truth, and `; var default <v>` is appended only when the file resolves that
 *                variable to something else. Without the flag the header says the tokens are raw
 *                values (the Variables API is Enterprise-only) and bindings read `$var:<short id>`.
 *   --out        write the markdown there and print `saved=<path> bytes=<n>`; the path's directory
 *                must already exist — this script creates nothing outside that one file.
 *   --max-text   truncate TEXT `characters` at N (default 200); the full length is always noted.
 *   --file-key   the file key for the header when the input is not named `<key>-<node>.nodes.json`.
 *   Without --out the markdown goes to stdout.
 *
 * STDERR / EXIT
 *   --stats → `figma-node-slim: <in> B → <out> B (-NN.N%) nodes=N hidden=N folded=N`.
 *   0 ok · 2 usage, unreadable input, non-JSON or a payload that is not a nodes response
 *   (one `figma-node-slim: error=<reason>` line on stderr, never a stack trace).
 *
 * Pure Node built-ins only (repo policy): fs and path.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_MAX_TEXT = 200;
// A variant-heavy instance carries a `props:{…}` list longer than the node line it rides on (209
// characters on a real page). Past this it moves to its own indented continuation line, the shape
// the per-run style table already uses, so one node still reads as one primary line.
const PROPS_INLINE_MAX = 120;
// Image refs are slots: an attribute carries this marker instead of the ref, so the fold key compares
// STRUCTURE (type, size, layout, style) while the ref travels in the fold's per-sibling delta list.
// A NUL can never occur in the rendered text — JSON.stringify escapes it out of every name and every
// `characters` value — so the marker is unambiguous. Position and text are slots too; they are plain
// record fields rather than markers, because each occupies a fixed place on the line.
const IMG_MARK = (i) => `\u0000IMG${i}\u0000`;

// -------------------------------------------------------------------------- formatting --

// Measurements are rounded to 0.5 px: Figma stores float noise (300.00000000000006) that no build
// can use, and the halves are real (hairlines, half-pixel offsets).
function num(v) {
  if (typeof v !== 'number' || !isFinite(v)) return '';
  const r = Math.round(v * 2) / 2;
  if (Object.is(r, -0)) return '0';
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

// Letter spacing, paragraph indent and friends are genuinely fractional (0.2, -0.5) — rounding them
// to the nearest half pixel would silently delete the value the design actually carries.
function fine(v) {
  if (typeof v !== 'number' || !isFinite(v)) return '';
  const r = Math.round(v * 100) / 100;
  if (Object.is(r, -0)) return '0';
  return String(r);
}

function pctOf(a) {
  const p = Math.round(a * 1000) / 10;
  return Number.isInteger(p) ? String(p) : p.toFixed(1);
}

function hex(c) {
  if (!c || typeof c !== 'object') return '';
  const b = (x) => Math.max(0, Math.min(255, Math.round((typeof x === 'number' ? x : 0) * 255)))
    .toString(16).toUpperCase().padStart(2, '0');
  return `#${b(c.r)}${b(c.g)}${b(c.b)}`;
}

// A quoted, single-line rendering: JSON.stringify escapes quotes, newlines and control characters,
// so a name or a text run can never break the one-node-per-line contract.
function quote(s) {
  return JSON.stringify(String(s == null ? '' : s));
}

function quoteText(s, max) {
  const full = String(s == null ? '' : s);
  if (full.length <= max) return quote(full);
  return `${quote(full.slice(0, max))} (+${full.length - max} chars, ${full.length} total)`;
}

// ---------------------------------------------------------------------------- variables --

// `/v1/variables/local` → id ⇒ { name: 'Collection/Group/Name', value: '<default-mode value>' }.
// An alias chain is followed to the value a build would actually ship, with a cycle guard.
function buildVars(varsPayload) {
  const out = new Map();
  const meta = varsPayload && varsPayload.meta;
  if (!meta || typeof meta !== 'object') return out;
  const cols = meta.variableCollections && typeof meta.variableCollections === 'object' ? meta.variableCollections : {};
  const vars = meta.variables && typeof meta.variables === 'object' ? meta.variables : {};
  const nameOf = (v) => {
    const col = cols[v.variableCollectionId];
    return `${col && col.name ? `${col.name}/` : ''}${v.name || v.id}`;
  };
  const valueOf = (v, seen) => {
    const col = cols[v.variableCollectionId];
    const modeId = (col && col.defaultModeId) || Object.keys(v.valuesByMode || {})[0];
    let val = v.valuesByMode ? v.valuesByMode[modeId] : undefined;
    let hops = 0;
    while (val && typeof val === 'object' && val.type === 'VARIABLE_ALIAS' && hops++ < 8) {
      if (seen.has(val.id)) return '(alias cycle)';
      seen.add(val.id);
      const next = vars[val.id];
      if (!next) return `(alias ${val.id})`;
      const nCol = cols[next.variableCollectionId];
      const nMode = (nCol && nCol.defaultModeId) || Object.keys(next.valuesByMode || {})[0];
      val = next.valuesByMode ? next.valuesByMode[nMode] : undefined;
    }
    if (val === undefined || val === null) return '';
    if (typeof val === 'object') {
      if (typeof val.r === 'number') {
        const a = typeof val.a === 'number' ? val.a : 1;
        return a < 1 ? `${hex(val)} ${pctOf(a)}%` : hex(val);
      }
      return '';
    }
    if (typeof val === 'number') return num(val);
    if (typeof val === 'boolean') return String(val);
    return quote(val);
  };
  for (const id of Object.keys(vars)) {
    const v = vars[id];
    if (!v || typeof v !== 'object') continue;
    out.set(id, { name: nameOf(v), value: valueOf(v, new Set([id])) });
  }
  return out;
}

// `VariableID:<40-hex>/<key>` → `<key>`. The hash names the LIBRARY, not the variable, and it is 40
// characters a reader can do nothing with; an id without a slash is already short and stays whole.
function shortVarId(id) {
  const s = String(id).replace(/^VariableID:/, '');
  const cut = s.lastIndexOf('/');
  return cut === -1 ? s : s.slice(cut + 1);
}

// ONE rendering of a bound value, printed ONCE. The NODE's own value is the render truth — a build
// ships what the node says — so it is what goes in the parentheses; the variables file supplies the
// NAME. A leading `$` marks "bound to a variable" (the legend says so), which is why the value never
// needs a second copy in brackets after it.
// The variables file's own default-mode value is then one of three things:
//   · equal to the node's → nothing more to say;
//   · DIFFERENT → `; var default <v>` puts the discrepancy on the line instead of silently picking a
//     side (a library value overridden on the node, or a frame captured in a non-default mode);
//   · unresolvable, because the alias chain left this file — the norm when every variable is a
//     library variable pointing at another library — so there is nothing to compare. The raw
//     `(alias VariableID:…)` is never printed: ~50 bytes of an id that leads nowhere.
// A bound field with no raw counterpart on the node falls back to the variables file's value.
function bindLabel(ctx, id, nodeValue) {
  const v = ctx.vars.get(id);
  const name = v && v.name ? v.name : `var:${shortVarId(id)}`;
  const fileValue = v && v.value && !v.value.startsWith('(alias') ? v.value : '';
  const own = nodeValue == null ? '' : String(nodeValue);
  if (!own) return fileValue ? `$${name} (${fileValue})` : `$${name}`;
  return `$${name} (${own}${fileValue && fileValue !== own ? `; var default ${fileValue}` : ''})`;
}

function aliasId(x) {
  return x && typeof x === 'object' && x.type === 'VARIABLE_ALIAS' && x.id ? x.id : null;
}

// ------------------------------------------------------------------------------- paints --

// `gradientHandlePositions` is the ONLY carrier of a gradient's direction (and, on the radial /
// angular / diamond types, of its centre and extent): the stops alone cannot tell `to right` from
// `to bottom`. It goes INSIDE the `…-gradient(…)` parens so it is part of the skeleton the fold key
// compares — two banners differing only in gradient axis are two different styles, never one.
// The handles are object-space coordinates (0,0 = top-left, y down), so the CSS angle is
// atan2(dx, -dy); an axis-aligned vector is named rather than given in degrees.
function gradientGeometry(p) {
  const hs = Array.isArray(p.gradientHandlePositions) ? p.gradientHandlePositions : [];
  if (!hs.length) return '';
  const pt = (h) => (h && typeof h === 'object' ? `${fine(h.x)},${fine(h.y)}` : '?');
  const a = hs[0];
  if (p.type === 'GRADIENT_LINEAR') {
    const b = hs[1];
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return `handles ${hs.map(pt).join('→')}`;
    const dx = (typeof b.x === 'number' ? b.x : 0) - (typeof a.x === 'number' ? a.x : 0);
    const dy = (typeof b.y === 'number' ? b.y : 0) - (typeof a.y === 'number' ? a.y : 0);
    let dir;
    if (dx === 0 && dy === 0) dir = 'no axis';
    else if (dx === 0) dir = dy > 0 ? 'to bottom' : 'to top';
    else if (dy === 0) dir = dx > 0 ? 'to right' : 'to left';
    else dir = `${fine(((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360)}deg`;
    return `${dir} ${pt(a)}→${pt(b)}`;
  }
  // radial / angular / diamond: handle 0 is the centre, 1 and 2 the ends of the two axes
  return `at ${pt(a)}${hs.length > 1 ? ` [${hs.slice(1).map(pt).join(' ')}]` : ''}`;
}

// `nodeBound` is the node-level `boundVariables.fills[i]` / `strokes[i]` entry: REST reports the same
// binding twice, once on the paint and once on the node. They are merged here so the value is named
// once — the old rendering printed the variable label and then repeated the whole thing in brackets.
function paintSummary(p, ctx, imgs, nodeBound) {
  if (!p || typeof p !== 'object') return '';
  const bits = [];
  const bound = (p.boundVariables && aliasId(p.boundVariables.color)) || nodeBound || null;
  const alpha = (typeof p.opacity === 'number' ? p.opacity : 1) * (p.color && typeof p.color.a === 'number' ? p.color.a : 1);
  switch (p.type) {
    case 'SOLID':
      bits.push(bound ? bindLabel(ctx, bound, hex(p.color)) : hex(p.color));
      if (alpha < 1) bits.push(`${pctOf(alpha)}%`);
      break;
    case 'IMAGE':
      imgs.push(String(p.imageRef == null ? '' : p.imageRef));
      bits.push(`image(${p.scaleMode || 'FILL'} ${IMG_MARK(imgs.length - 1)})`);
      if (typeof p.opacity === 'number' && p.opacity < 1) bits.push(`${pctOf(p.opacity)}%`);
      break;
    case 'GRADIENT_LINEAR':
    case 'GRADIENT_RADIAL':
    case 'GRADIENT_ANGULAR':
    case 'GRADIENT_DIAMOND': {
      const stops = Array.isArray(p.gradientStops) ? p.gradientStops : [];
      const kind = p.type.replace('GRADIENT_', '').toLowerCase();
      const shown = stops.map((s) => {
        const sb = s.boundVariables && aliasId(s.boundVariables.color);
        const sa = s.color && typeof s.color.a === 'number' ? s.color.a : 1;
        const val = `${hex(s.color)}${sa < 1 ? ` ${pctOf(sa)}%` : ''}`;
        return `${sb ? bindLabel(ctx, sb, val) : val}@${pctOf(typeof s.position === 'number' ? s.position : 0)}%`;
      });
      const geo = gradientGeometry(p);
      bits.push(`${kind}-gradient(${geo ? `${geo}, ` : ''}${shown.join(' → ')})`);
      if (typeof p.opacity === 'number' && p.opacity < 1) bits.push(`${pctOf(p.opacity)}%`);
      break;
    }
    default:
      bits.push(String(p.type || 'PAINT').toLowerCase());
      if (typeof p.opacity === 'number' && p.opacity < 1) bits.push(`${pctOf(p.opacity)}%`);
  }
  // A non-SOLID paint carries no single colour the binding could have supplied, so the name leads the
  // summary instead of replacing a value inside it. (Every real payload seen binds SOLID paints only.)
  if (bound && p.type !== 'SOLID') bits.unshift(bindLabel(ctx, bound, ''));
  if (p.visible === false) bits.push('off');
  if (p.blendMode && p.blendMode !== 'NORMAL') bits.push(p.blendMode.toLowerCase());
  return bits.filter(Boolean).join(' ');
}

function paintList(list, ctx, imgs, bindings) {
  if (!Array.isArray(list) || !list.length) return '';
  return list
    .map((p, i) => paintSummary(p, ctx, imgs, bindings && bindings[i] ? aliasId(bindings[i]) : null))
    .filter(Boolean).join(', ');
}

function effectSummary(e, ctx) {
  if (!e || typeof e !== 'object') return '';
  const c = e.color ? `${hex(e.color)}${typeof e.color.a === 'number' && e.color.a < 1 ? ` ${pctOf(e.color.a)}%` : ''}` : '';
  const off = e.offset ? `${num(e.offset.x)},${num(e.offset.y)}` : '';
  const bits = [];
  switch (e.type) {
    case 'DROP_SHADOW':
    case 'INNER_SHADOW':
      bits.push(`${e.type === 'INNER_SHADOW' ? 'inner-shadow' : 'shadow'}:${off}`);
      if (typeof e.radius === 'number') bits.push(`blur ${num(e.radius)}`);
      if (typeof e.spread === 'number' && e.spread !== 0) bits.push(`spread ${num(e.spread)}`);
      if (c) bits.push(c);
      break;
    case 'LAYER_BLUR':
    case 'BACKGROUND_BLUR':
      bits.push(`${e.type === 'LAYER_BLUR' ? 'blur' : 'backdrop-blur'}:${num(e.radius)}`);
      break;
    default:
      bits.push(String(e.type || 'effect').toLowerCase());
  }
  if (e.visible === false) bits.push('off');
  return bits.filter(Boolean).join(' ');
}

// A component property's value is a string, a number or a boolean — except on a SLOT, where it is
// `{guid:{sessionID,localID}}` naming the node that fills the slot. `String()` on that is
// `[object Object]`, which throws away the only thing the property carries, so the guid renders as
// the node id it is (`13938:520614`), the `-1:-1` sentinel as `empty` (the slot is unfilled), and any
// other object as compact JSON — verbose, but data is never lost to a placeholder.
function propValue(v) {
  if (typeof v === 'string') return quote(v);
  if (v !== null && typeof v === 'object') {
    const g = v.guid;
    if (g && typeof g === 'object' && typeof g.sessionID === 'number' && typeof g.localID === 'number') {
      return g.sessionID === -1 && g.localID === -1 ? 'empty' : `${g.sessionID}:${g.localID}`;
    }
    try { return JSON.stringify(v); } catch (e) { return '(unprintable)'; }
  }
  return String(v);
}

// ------------------------------------------------------------------------ node → record --

// Every node becomes ONE record. `label`/`name`/`size`/`attrs`/`tail` are the SKELETON (what folding
// compares); `id`, `pos`, `imgs` and `chars` are the slots (what a fold lists per sibling).
function record(n, depth, parentLayout, ctx) {
  const imgs = [];
  const attrs = [];
  const tail = [];

  let label = n.type || 'NODE';
  if (n.type === 'INSTANCE') {
    const comp = ctx.components[n.componentId];
    label = comp && comp.name ? `INSTANCE of ${quote(comp.name)}` : 'INSTANCE';
    if (!(comp && comp.name) && n.componentId) attrs.push(`component:${n.componentId}`);
  }

  const box = n.absoluteBoundingBox;
  const size = box ? `${num(box.width)}x${num(box.height)}` : '';
  const pos = box && (typeof box.x === 'number' || typeof box.y === 'number') ? `@${num(box.x)},${num(box.y)}` : '';

  // auto-layout
  if (n.layoutMode && n.layoutMode !== 'NONE') {
    const bits = [`layout:${n.layoutMode === 'HORIZONTAL' ? 'row' : 'col'}`];
    const gapVar = n.boundVariables && aliasId(n.boundVariables.itemSpacing);
    const gapVal = typeof n.itemSpacing === 'number' ? num(n.itemSpacing) : '';
    if (gapVar) bits.push(`gap ${bindLabel(ctx, gapVar, gapVal)}`);
    else if (gapVal && gapVal !== '0') bits.push(`gap ${gapVal}`);
    if (n.layoutWrap === 'WRAP') {
      bits.push('wrap');
      if (typeof n.counterAxisSpacing === 'number' && n.counterAxisSpacing !== 0) bits.push(`row-gap ${num(n.counterAxisSpacing)}`);
    }
    const pads = ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'].map((k) => {
      const pv = n.boundVariables && aliasId(n.boundVariables[k]);
      const raw = typeof n[k] === 'number' ? num(n[k]) : '';
      return pv ? bindLabel(ctx, pv, raw) : (raw || '0');
    });
    if (pads.some((p) => p !== '0')) bits.push(`pad ${pads.join('/')}`);
    if (n.primaryAxisAlignItems && n.primaryAxisAlignItems !== 'MIN') bits.push(`primary:${n.primaryAxisAlignItems}`);
    if (n.counterAxisAlignItems && n.counterAxisAlignItems !== 'MIN') bits.push(`counter:${n.counterAxisAlignItems}`);
    attrs.push(bits.join(' '));
  }
  if (n.layoutPositioning === 'ABSOLUTE') attrs.push('absolute');

  const sz = sizing(n, parentLayout);
  if (sz) attrs.push(sz);

  // fills / strokes — `background` is the deprecated alias of `fills` on a FRAME; name it only when
  // it carries something `fills` does not, so the common case does not pay for it twice.
  const fillBind = n.boundVariables && Array.isArray(n.boundVariables.fills) ? n.boundVariables.fills : null;
  const fills = paintList(n.fills, ctx, imgs, fillBind);
  if (fills) attrs.push(`fill:${fills}`);
  if (!fills && Array.isArray(n.background) && n.background.length) {
    const bg = paintList(n.background, ctx, imgs, null);
    if (bg) attrs.push(`bg:${bg}`);
  }
  const strokeBind = n.boundVariables && Array.isArray(n.boundVariables.strokes) ? n.boundVariables.strokes : null;
  const strokes = paintList(n.strokes, ctx, imgs, strokeBind);
  if (strokes) {
    const bits = [`stroke:${strokes}`];
    const wVar = n.boundVariables && aliasId(n.boundVariables.strokeWeight);
    // Per-side borders — a bottom-only divider is the classic one. REST spells them
    // `individualStrokeWeights: {top,right,bottom,left}`; `strokeTopWeight`/… are the PLUGIN API's
    // names for the same thing, kept as a second source so a payload from either side reads the
    // same. Reading only the plugin names would collapse `border-bottom: 2px` into a 1px box on
    // all four sides — and let it fold with a sibling that really is one.
    const ind = n.individualStrokeWeights && typeof n.individualStrokeWeights === 'object' ? n.individualStrokeWeights : null;
    const sides = [['top', 'strokeTopWeight'], ['right', 'strokeRightWeight'],
      ['bottom', 'strokeBottomWeight'], ['left', 'strokeLeftWeight']];
    const perSide = sides.map(([rk, pk]) => {
      if (ind && typeof ind[rk] === 'number') return ind[rk];
      if (typeof n[pk] === 'number') return n[pk];
      return null;
    });
    if (perSide.some((w) => w !== null)) {
      bits.push(`${perSide.map((w) => num(w === null ? (typeof n.strokeWeight === 'number' ? n.strokeWeight : 0) : w)).join('/')}px`);
    } else if (wVar) bits.push(`${bindLabel(ctx, wVar, typeof n.strokeWeight === 'number' ? num(n.strokeWeight) : '')}px`);
    else if (typeof n.strokeWeight === 'number') bits.push(`${num(n.strokeWeight)}px`);
    if (n.strokeAlign) bits.push(n.strokeAlign);
    if (Array.isArray(n.strokeDashes) && n.strokeDashes.length) bits.push(`dash ${n.strokeDashes.map(num).join(',')}`);
    attrs.push(bits.join(' '));
  }

  // corner radius
  const radVar = n.boundVariables && aliasId(n.boundVariables.cornerRadius);
  if (Array.isArray(n.rectangleCornerRadii) && n.rectangleCornerRadii.length === 4) {
    attrs.push(`radius:${n.rectangleCornerRadii.map(num).join('/')}`);
  } else if (radVar) attrs.push(`radius:${bindLabel(ctx, radVar, typeof n.cornerRadius === 'number' ? num(n.cornerRadius) : '')}`);
  else if (typeof n.cornerRadius === 'number' && n.cornerRadius !== 0) attrs.push(`radius:${num(n.cornerRadius)}`);
  if (typeof n.cornerSmoothing === 'number' && n.cornerSmoothing !== 0) attrs.push(`smooth:${pctOf(n.cornerSmoothing)}%`);

  // effects
  if (Array.isArray(n.effects) && n.effects.length) {
    const eff = n.effects.map((e) => effectSummary(e, ctx)).filter(Boolean).join(', ');
    if (eff) attrs.push(eff);
  }

  // layout grids (column/row grids a build has to reproduce)
  if (Array.isArray(n.layoutGrids) && n.layoutGrids.length) {
    attrs.push(`grid:${n.layoutGrids.map((g) => [g.pattern || g.alignment, g.count != null ? `x${g.count}` : '',
      g.gutterSize != null ? `gutter ${num(g.gutterSize)}` : '', g.sectionSize != null ? `size ${num(g.sectionSize)}` : '',
      g.offset ? `offset ${num(g.offset)}` : ''].filter(Boolean).join(' ')).join(', ')}`);
  }

  // box model odds and ends
  for (const [k, tag] of [['minWidth', 'min-w'], ['maxWidth', 'max-w'], ['minHeight', 'min-h'], ['maxHeight', 'max-h']]) {
    if (typeof n[k] === 'number') attrs.push(`${tag}:${num(n[k])}`);
  }
  // Constraints are named only when they are NOT Figma's default (TOP/LEFT) — the legend says so, and
  // on a 300-node frame the default would otherwise cost more bytes than every effect put together.
  if (n.constraints && (n.constraints.vertical || n.constraints.horizontal)
      && !(n.constraints.vertical === 'TOP' && n.constraints.horizontal === 'LEFT')) {
    attrs.push(`cst:${n.constraints.vertical || '-'}/${n.constraints.horizontal || '-'}`);
  }
  if (typeof n.opacity === 'number' && n.opacity !== 1) attrs.push(`opacity:${pctOf(n.opacity)}%`);
  if (n.blendMode && n.blendMode !== 'NORMAL' && n.blendMode !== 'PASS_THROUGH') attrs.push(`blend:${n.blendMode}`);
  if (n.clipsContent === true) attrs.push('clip');
  if (n.isMask === true) attrs.push('mask');
  if (typeof n.rotation === 'number' && Math.abs(n.rotation) > 0.0001) attrs.push(`rot:${num(n.rotation)}`);

  // named styles from the file's styles map
  if (n.styles && typeof n.styles === 'object') {
    for (const key of Object.keys(n.styles).sort()) {
      const ref = n.styles[key];
      const ids = Array.isArray(ref) ? ref : [ref];
      const names = ids.map((sid) => {
        const st = ctx.styles[sid];
        return st && st.name ? quote(st.name) : `style:${sid}`;
      });
      attrs.push(`${key}Style:${names.join(', ')}`);
    }
  }

  // The instance's component properties — variant choices and text props, with their values. The
  // sibling `overrides` array is NOT rendered: see the dropped-by-design note in the file header.
  if (n.componentProperties && typeof n.componentProperties === 'object') {
    const props = Object.keys(n.componentProperties).map((k) => {
      const p = n.componentProperties[k];
      const v = p && typeof p === 'object' && 'value' in p ? p.value : p;
      return `${k.split('#')[0]}=${propValue(v)}`;
    });
    if (props.length) {
      const line = `props:{${props.join(', ')}}`;
      if (line.length > PROPS_INLINE_MAX) tail.push(line);
      else attrs.push(line);
    }
  }

  // TEXT — characters, typography, and the per-run style table when the text is not uniform.
  // The typography goes into a document-wide table (`T1`, `T2`, …): one PLP frame repeats the same
  // three faces across every card, and the table is the difference between naming them 180 times and
  // naming them three times. Its entries are printed in the header block.
  let chars = null;
  let typeRef = '';
  if (typeof n.characters === 'string') {
    chars = n.characters;
    const st = n.style && typeof n.style === 'object' ? n.style : null;
    const line = st ? fontLine(st, ctx, n.boundVariables) : '';
    if (line) typeRef = ctx.typeRef(line);
    const table = n.styleOverrideTable && typeof n.styleOverrideTable === 'object' ? n.styleOverrideTable : null;
    if (table && Object.keys(table).length) {
      for (const k of Object.keys(table)) tail.push(`run ${k}: ${ctx.typeRef(fontLine(table[k], ctx, null))}`);
      const runs = rleRuns(n.characterStyleOverrides);
      if (runs) tail.push(`runs: ${runs}`);
    }
  }

  return {
    depth,
    id: String(n.id == null ? '' : n.id),
    label: `[${label}]`,
    name: quote(n.name),
    size,
    pos,
    typeRef,
    attrs,
    tail,
    imgs,
    chars,
    fold: 0,
    foldRows: null,
  };
}

// hug / fill / fixed per axis: the explicit fields when Figma sent them, otherwise derived from the
// legacy sizing modes and the node's relation to its parent's auto-layout axis.
function sizing(n, parentLayout) {
  let h = n.layoutSizingHorizontal;
  let v = n.layoutSizingVertical;
  const own = n.layoutMode && n.layoutMode !== 'NONE';
  if (own) {
    const prim = n.primaryAxisSizingMode === 'AUTO' ? 'HUG' : (n.primaryAxisSizingMode ? 'FIXED' : null);
    const cnt = n.counterAxisSizingMode === 'AUTO' ? 'HUG' : (n.counterAxisSizingMode ? 'FIXED' : null);
    if (n.layoutMode === 'HORIZONTAL') { h = h || prim; v = v || cnt; } else { v = v || prim; h = h || cnt; }
  }
  if (parentLayout === 'HORIZONTAL' || parentLayout === 'VERTICAL') {
    const along = parentLayout === 'HORIZONTAL' ? 'h' : 'v';
    if (n.layoutGrow === 1) { if (along === 'h') h = h || 'FILL'; else v = v || 'FILL'; }
    if (n.layoutAlign === 'STRETCH') { if (along === 'h') v = v || 'FILL'; else h = h || 'FILL'; }
  }
  if (!h && !v) return '';
  return `size:${(h || 'FIXED').toLowerCase()}/${(v || 'FIXED').toLowerCase()}`;
}

function fontLine(st, ctx, bound) {
  if (!st || typeof st !== 'object') return '';
  const bits = [];
  const family = st.fontFamily || '';
  // "Inter-SemiBold" → the face name Figma shows next to the family in the type panel.
  let face = st.fontStyle || '';
  if (!face && typeof st.fontPostScriptName === 'string' && st.fontPostScriptName.includes('-')) {
    face = st.fontPostScriptName.slice(st.fontPostScriptName.indexOf('-') + 1);
  }
  if (family || face) bits.push([family, face].filter(Boolean).join('/'));
  if (st.italic === true) bits.push('italic');
  if (typeof st.fontWeight === 'number') bits.push(`w${st.fontWeight}`);
  const sizeVar = bound && aliasId(bound.fontSize);
  if (typeof st.fontSize === 'number' || sizeVar) {
    const lh = st.lineHeightUnit === 'PERCENT' || st.lineHeightUnit === 'FONT_SIZE_%'
      ? (typeof st.lineHeightPercentFontSize === 'number' ? `${num(st.lineHeightPercentFontSize)}%` : (typeof st.lineHeightPercent === 'number' ? `${num(st.lineHeightPercent)}%` : ''))
      : (typeof st.lineHeightPx === 'number' ? num(st.lineHeightPx) : '');
    const sizeVal = typeof st.fontSize === 'number' ? num(st.fontSize) : '';
    // The brackets stay here: a variable NAME contains slashes, and `size/line-height` is written with
    // one too — `[…]` is what keeps `[$Type/Body (16)]/24` readable as one size plus one line height.
    bits.push(`${sizeVar ? `[${bindLabel(ctx, sizeVar, sizeVal)}]` : sizeVal}${lh ? `/${lh}` : ''}`);
  }
  if (typeof st.letterSpacing === 'number' && st.letterSpacing !== 0) bits.push(`ls:${fine(st.letterSpacing)}`);
  if (st.textCase && st.textCase !== 'ORIGINAL') bits.push(`case:${st.textCase}`);
  if (st.textDecoration && st.textDecoration !== 'NONE') bits.push(`deco:${st.textDecoration}`);
  if (st.textAlignHorizontal || st.textAlignVertical) bits.push(`align:${st.textAlignHorizontal || '-'}/${st.textAlignVertical || '-'}`);
  if (st.textAutoResize) bits.push(`autoresize:${st.textAutoResize}`);
  if (st.textTruncation && st.textTruncation !== 'DISABLED') bits.push(`truncate:${st.textTruncation}${st.maxLines ? ` ${st.maxLines}` : ''}`);
  if (typeof st.paragraphSpacing === 'number' && st.paragraphSpacing !== 0) bits.push(`para:${num(st.paragraphSpacing)}`);
  if (typeof st.paragraphIndent === 'number' && st.paragraphIndent !== 0) bits.push(`indent:${num(st.paragraphIndent)}`);
  if (st.listSpacing) bits.push(`list:${num(st.listSpacing)}`);
  // A link destination is buildable data — a footer/menu item's href — and it renders as nothing at
  // all, so the PNG cannot recover it. It rides the type-style entry, which puts it in the fold key:
  // a linked TEXT node can no longer fold into an unlinked twin.
  if (st.hyperlink && typeof st.hyperlink === 'object') {
    const nodeRef = st.hyperlink.nodeID || st.hyperlink.nodeId;
    if (st.hyperlink.url) bits.push(`link:${st.hyperlink.url}`);
    else if (nodeRef) bits.push(`link:node ${nodeRef}`);
  }
  return bits.filter(Boolean).join(' ');
}

// `characterStyleOverrides` is one style key per character; as ranges it is a fraction of the bytes
// and says the same thing: which characters take which run style.
function rleRuns(arr) {
  if (!Array.isArray(arr) || !arr.length) return '';
  const out = [];
  let start = 0;
  for (let i = 1; i <= arr.length; i++) {
    if (i === arr.length || arr[i] !== arr[start]) {
      out.push(`${start}${i - 1 > start ? `-${i - 1}` : ''}:${arr[start]}`);
      start = i;
    }
  }
  return out.join(' ');
}

// ------------------------------------------------------------------------------ folding --

// The fold key is the skeleton only: type, name, size, every attribute (layout, fills, strokes,
// radius, effects, styles) and the typography tail — with image refs and `characters` already
// replaced by slot markers. So siblings fold ONLY when their structure, size, layout and style are
// identical; what differs (id, position, image ref, text) is listed per sibling and nothing is lost.
function skelKey(recs) {
  if (recs._key === undefined) {
    // `r.fold` is part of the key: a record that already folded its own children stands for a
    // DIFFERENT number of nodes than one that did not, and merging the two would strand the inner
    // fold's id list (it lives on the exemplar that is about to be dropped).
    recs._key = JSON.stringify(recs.map((r) => [r.depth, r.label, r.name, r.size, r.typeRef, r.attrs, r.tail, r.fold]));
  }
  return recs._key;
}

function foldDelta(exemplar, sibling, maxText) {
  const cells = [];
  for (let i = 0; i < exemplar.length; i++) {
    const e = exemplar[i];
    const s = sibling[i];
    const bits = [`#${s.id}`];
    if (s.pos && s.pos !== e.pos) bits.push(s.pos);
    for (let k = 0; k < s.imgs.length; k++) {
      if (s.imgs[k] !== e.imgs[k]) bits.push(`img${s.imgs.length > 1 ? k : ''}=${s.imgs[k]}`);
    }
    if (s.chars !== null && s.chars !== e.chars) bits.push(quoteText(s.chars, maxText));
    // This node folded siblings of its own: carry ITS fold list into the cell, or the inner fold's
    // ids would be lost with the exemplar that is being dropped here.
    if (s.fold && s.foldRows && s.foldRows.length) bits.push(`{${s.foldRows.join(' ; ')}}`);
    cells.push(bits.join(' '));
  }
  return cells.join(' · ');
}

// --------------------------------------------------------------------------- the walker --

function countNodes(n) {
  let c = 1;
  if (Array.isArray(n.children)) for (const k of n.children) c += countNodes(k);
  return c;
}

function subtree(n, depth, parentLayout, ctx, stats) {
  if (!n || typeof n !== 'object') return null;
  if (n.visible === false) { stats.hidden += countNodes(n); return null; }
  stats.visible++;
  const self = record(n, depth, parentLayout, ctx);
  const recs = [self];
  const kids = Array.isArray(n.children) ? n.children : [];
  const subs = [];
  for (const k of kids) {
    const s = subtree(k, depth + 1, n.layoutMode, ctx, stats);
    if (s) subs.push(s);
  }
  let i = 0;
  while (i < subs.length) {
    let j = i + 1;
    const key = skelKey(subs[i]);
    while (j < subs.length && skelKey(subs[j]) === key) j++;
    const group = subs.slice(i, j);
    if (group.length > 1) {
      const ex = group[0];
      ex[0].fold = group.length;
      ex[0].foldRows = group.slice(1).map((g) => foldDelta(ex, g, ctx.maxText));
      stats.folded += (group.length - 1) * ex.length;
      stats.foldGroups++;
      for (const r of ex) recs.push(r);
    } else {
      for (const r of group[0]) recs.push(r);
    }
    i = j;
  }
  return recs;
}

// ----------------------------------------------------------------------------- renderer --

function renderLine(r, maxText) {
  const subst = (s) => {
    let out = s;
    for (let i = 0; i < r.imgs.length; i++) out = out.split(IMG_MARK(i)).join(r.imgs[i] || '(no ref)');
    return out;
  };
  const head = [r.label, r.name, `#${r.id}`, r.size, r.pos,
    r.chars !== null ? quoteText(r.chars, maxText) : '', r.typeRef, ...r.attrs.map(subst)].filter(Boolean).join(' ');
  const lines = [`${'  '.repeat(r.depth)}${head}${r.fold ? ` ×${r.fold}` : ''}`];
  for (const t of r.tail) lines.push(`${'  '.repeat(r.depth + 1)}${subst(t)}`);
  return lines;
}

function renderTree(recs, maxText) {
  const lines = [];
  // Walks the pre-order record array as a tree so a fold nested INSIDE an exemplar still prints its
  // own fold block (the flat loop this replaces skipped over the exemplar's subtree wholesale).
  const emit = (from, to) => {
    let i = from;
    while (i < to) {
      const r = recs[i];
      const len = subtreeLen(recs, i);
      for (const l of renderLine(r, maxText)) lines.push(l);
      emit(i + 1, i + len);
      if (r.fold && r.foldRows) {
        // The fold block sits under the exemplar's WHOLE subtree, at the exemplar's own indent, so
        // the next real sibling is still readable as a sibling.
        lines.push(`${'  '.repeat(r.depth)}folds ×${r.fold - 1} (one line per folded sibling, one cell per node in the exemplar's order — only what differs is listed):`);
        for (const row of r.foldRows) lines.push(`${'  '.repeat(r.depth)}${row}`);
      }
      i += len;
    }
  };
  emit(0, recs.length);
  return lines;
}

// Records are pre-order, so a node's subtree runs until the next record at its own depth or shallower.
function subtreeLen(recs, i) {
  const d = recs[i].depth;
  let j = i + 1;
  while (j < recs.length && recs[j].depth > d) j++;
  return j - i;
}

// --------------------------------------------------------------------------------- main --

class SlimError extends Error {
  constructor(reason, detail) { super(reason); this.reason = reason; this.detail = detail || ''; }
}

// `<key>-<node>.nodes.json` is what figma-rest.sh writes; a file key is `[A-Za-z0-9]+`, so the key is
// everything before the first dash. Anything else → no claim about the key.
function keyFromName(file) {
  const m = /^([A-Za-z0-9]+)-.+\.nodes\.json$/.exec(path.basename(String(file || '')));
  return m ? m[1] : '';
}

function compact(payload, opts) {
  const o = opts || {};
  // `--max-text 0` is a real answer ("count the characters, print none of them"), not a missing value.
  const maxText = typeof o.maxText === 'number' && isFinite(o.maxText) && o.maxText >= 0 ? Math.floor(o.maxText) : DEFAULT_MAX_TEXT;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new SlimError('not_a_node_response', 'top level is not an object');
  const nodes = payload.nodes;
  if (!nodes || typeof nodes !== 'object' || Array.isArray(nodes)) throw new SlimError('not_a_node_response', 'no `nodes` object — this is not a /v1/files/<key>/nodes response');
  const ids = Object.keys(nodes);
  if (!ids.length) throw new SlimError('no_nodes', 'the `nodes` object is empty');

  const stats = { visible: 0, hidden: 0, folded: 0, foldGroups: 0 };
  const blocks = [];
  const headNodes = [];
  // One typography table for the whole document, in first-appearance order.
  const typeTable = new Map();
  const typeRef = (line) => {
    if (!line) return '';
    let ref = typeTable.get(line);
    if (!ref) { ref = `T${typeTable.size + 1}`; typeTable.set(line, ref); }
    return ref;
  };
  const vars = buildVars(o.variables);
  for (const id of ids) {
    const entry = nodes[id];
    if (!entry || typeof entry !== 'object' || !entry.document || typeof entry.document !== 'object') {
      throw new SlimError('node_missing', `nodes.${id} carries no document`);
    }
    const ctx = {
      components: entry.components && typeof entry.components === 'object' ? entry.components : {},
      componentSets: entry.componentSets && typeof entry.componentSets === 'object' ? entry.componentSets : {},
      styles: entry.styles && typeof entry.styles === 'object' ? entry.styles : {},
      vars,
      typeRef,
      maxText,
    };
    const recs = subtree(entry.document, 0, null, ctx, stats);
    headNodes.push({ id, name: entry.document.name || '' });
    blocks.push({ id, name: entry.document.name || '', lines: recs ? renderTree(recs, maxText) : ['(the requested node is hidden — visible:false)'] });
  }

  const fileKey = o.fileKey || '';
  const hasVars = !!(o.variables && o.variables.meta);
  const bytesIn = typeof o.bytesIn === 'number' ? o.bytesIn : 0;

  const assemble = (bytesOut) => {
    const pct = bytesIn > 0 ? ((1 - bytesOut / bytesIn) * 100) : 0;
    const out = [];
    out.push(`# figma node${headNodes.length === 1 ? '' : 's'} ${headNodes.map((h) => h.id).join(', ')}${headNodes.length === 1 && headNodes[0].name ? ` — ${quote(headNodes[0].name)}` : ''}`);
    out.push('');
    out.push(`file: ${fileKey ? fileKey : '(key unknown)'}${payload.name ? ` · ${quote(payload.name)}` : ''}`);
    out.push(`lastModified: ${payload.lastModified || '(unknown)'}`);
    out.push(`nodes: ${stats.visible} visible · ${stats.hidden} hidden dropped · ${stats.folded} folded` +
      `${stats.foldGroups ? ` into ${stats.foldGroups} exemplar${stats.foldGroups === 1 ? '' : 's'}` : ''}`);
    out.push(hasVars ? 'tokens: variables' : 'tokens: raw values (Variables API unavailable on this plan)');
    out.push(`bytes: ${bytesIn} → ${bytesOut} (${pct >= 0 ? '-' : '+'}${Math.abs(Math.round(pct * 10) / 10).toFixed(1)}%)`);
    out.push('legend: `[TYPE] "name" #id WxH @x,y` then, when present, the TEXT content, its `T<n>` type');
    out.push('  style from the table below, and the attributes · `size:h/v` = hug|fill|fixed per axis ·');
    out.push('  `cst:v/h` = constraints, printed only when they are not the default TOP/LEFT · a `×N`');
    out.push('  node folds N identical siblings and the `folds ×N` block below it lists every folded id');
    out.push('  with the values that differ, one cell per node, in the exemplar\'s order · `$Name (v)`');
    out.push('  = bound to variable `Name`, `v` = the NODE\'s own value (what a build ships), and a');
    out.push('  trailing `; var default <d>` = the variables file resolves `Name` to `<d>` instead.');
    if (typeTable.size) {
      out.push('');
      out.push('type styles:');
      for (const [line, ref] of typeTable) out.push(`  ${ref} = ${line}`);
    }
    out.push('');
    for (const b of blocks) {
      if (blocks.length > 1) { out.push(`## ${b.id} ${quote(b.name)}`); out.push(''); }
      for (const l of b.lines) out.push(l);
      out.push('');
    }
    return out.join('\n');
  };

  // The header states the output's own byte count, so it is a fixed point: assemble, measure,
  // re-assemble until the number stops moving (digit width is the only thing that can shift).
  let n = Buffer.byteLength(assemble(0), 'utf8');
  for (let i = 0; i < 12; i++) {
    const m = Buffer.byteLength(assemble(n), 'utf8');
    if (m === n) break;
    n = m;
  }
  const md = assemble(n);
  return { md, stats: { ...stats, bytesIn, bytesOut: Buffer.byteLength(md, 'utf8') } };
}

function readJson(file, reason) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { throw new SlimError(reason.read, `${file}: ${e.code || e.message}`); }
  try { return { json: JSON.parse(raw), bytes: Buffer.byteLength(raw, 'utf8') }; } catch (e) { throw new SlimError(reason.parse, `${file}: ${e.message}`); }
}

const USAGE = 'node figma-node-slim.cjs <nodes.json> [--variables <variables.json>] [--out <file.md>] [--stats] [--max-text <N>] [--file-key <key>]';

function main(argv) {
  const VALUE_FLAGS = ['--variables', '--out', '--max-text', '--file-key'];
  const KNOWN = new Set([...VALUE_FLAGS, '--stats', '--help', '-h']);
  const args = argv.slice();
  if (args.some((a, i) => (a === '--help' || a === '-h') && !VALUE_FLAGS.includes(args[i - 1]))) {
    process.stdout.write(`figma-node-slim: usage: ${USAGE}\n`);
    return 0;
  }
  const unknown = args.find((a, i) => a.startsWith('-') && !KNOWN.has(a) && !VALUE_FLAGS.includes(args[i - 1]));
  if (unknown !== undefined) {
    process.stderr.write(`figma-node-slim: error=usage detail=unknown option ${unknown} — ${USAGE}\n`);
    return 2;
  }
  const opt = (f) => { const i = args.indexOf(f); return i !== -1 && args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[i + 1] : null; };
  const file = args.find((a, i) => !a.startsWith('-') && !VALUE_FLAGS.includes(args[i - 1]));
  if (!file) {
    process.stderr.write(`figma-node-slim: error=usage detail=no <nodes.json> — ${USAGE}\n`);
    return 2;
  }
  const maxTextRaw = opt('--max-text');
  if (maxTextRaw !== null && !/^[0-9]+$/.test(maxTextRaw)) {
    process.stderr.write(`figma-node-slim: error=usage detail=--max-text takes a non-negative integer, got ${maxTextRaw}\n`);
    return 2;
  }
  try {
    const input = readJson(file, { read: 'input_unreadable', parse: 'invalid_json' });
    const varsFile = opt('--variables');
    let variables = null;
    if (varsFile) variables = readJson(varsFile, { read: 'variables_unreadable', parse: 'invalid_variables_json' }).json;
    const res = compact(input.json, {
      variables,
      bytesIn: input.bytes,
      maxText: maxTextRaw !== null ? Number(maxTextRaw) : DEFAULT_MAX_TEXT,
      fileKey: opt('--file-key') || keyFromName(file),
    });
    const out = opt('--out');
    if (out) {
      try { fs.writeFileSync(out, res.md); } catch (e) { throw new SlimError('out_unwritable', `${out}: ${e.code || e.message}`); }
      process.stdout.write(`saved=${path.resolve(out)} bytes=${res.stats.bytesOut}\n`);
    } else {
      process.stdout.write(res.md);
    }
    if (args.includes('--stats')) {
      const pct = res.stats.bytesIn > 0 ? (1 - res.stats.bytesOut / res.stats.bytesIn) * 100 : 0;
      process.stderr.write(`figma-node-slim: ${res.stats.bytesIn} B → ${res.stats.bytesOut} B ` +
        `(${pct >= 0 ? '-' : '+'}${Math.abs(Math.round(pct * 10) / 10).toFixed(1)}%) ` +
        `nodes=${res.stats.visible} hidden=${res.stats.hidden} folded=${res.stats.folded}\n`);
    }
    return 0;
  } catch (e) {
    if (e instanceof SlimError) {
      process.stderr.write(`figma-node-slim: error=${e.reason}${e.detail ? ` detail=${e.detail}` : ''}\n`);
      return 2;
    }
    // Nothing here is expected to throw anything else; a bug still leaves one named line, never a stack.
    process.stderr.write(`figma-node-slim: error=internal detail=${e && e.message ? e.message : String(e)}\n`);
    return 2;
  }
}

module.exports = { compact, __test: { num, fine, hex, quote, quoteText, buildVars, bindLabel, shortVarId, sizing, fontLine, propValue, rleRuns, keyFromName, skelKey, foldDelta, paintSummary, gradientGeometry, effectSummary, DEFAULT_MAX_TEXT, PROPS_INLINE_MAX } };

if (require.main === module) {
  // A downstream `| head` closes stdout mid-write; the EPIPE (Windows: `code: 'EOF'`) surfaces on a
  // later tick and would crash the process AFTER the consumer already got its bytes. Reader-side
  // truncation is success — exit quietly; other stream errors still throw.
  const quietOnEpipe = (s) => s.on('error', (e) => { if (e && (e.code === 'EPIPE' || e.code === 'EOF')) process.exit(0); throw e; });
  quietOnEpipe(process.stdout);
  quietOnEpipe(process.stderr);
  process.exitCode = main(process.argv.slice(2));
}
