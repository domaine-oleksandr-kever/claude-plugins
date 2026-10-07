/*
 * engines/figma.cjs — lossless compactor for Figma dev-mode design-context JSX.
 *
 * Measured on a real 211 KB section: `className="…"` strings are 57 % of the payload with 98 unique
 * values across 804 occurrences, `data-node-id` another 33 KB, and whole sibling subtrees repeat
 * verbatim. Three line-oriented transforms, no JSX parser:
 *   1. className dictionary — repeated values move to a `C17: …` legend on top, occurrences become
 *      `class=C17`; inside the legend repeated `var(--…)` tokens shorten to `$N`;
 *   2. node-id legend — `data-node-id="I13920:240400;…"` becomes `#n17`, and the `n17 → full id`
 *      map leaves as an `ids` part the caller stores, so the ids stay usable for follow-up calls;
 *   3. ×N sibling fold — adjacent sibling subtrees identical apart from a small set of value slots
 *      collapse to one exemplar plus a `{/* ×3 more … *\/}` line that LISTS what differed.
 * Scope is ONLY this machine-generated grammar (detectJsx) — generic HTML/XML/Liquid is never
 * touched. Pure: no I/O, no requires.
 */
'use strict';

const JSX_HEADER = '<<fnd-jsx-slim>>';
const JSX_MIN_HITS = 3; // each signature must appear at least this often before the stage engages

// Occurrence counter with an early exit at `cap`. indexOf, never a regex: a payload can be 200 KB on
// ONE physical line, where a counting regex backtracks quadratically.
function countUpTo(hay, needle, cap) {
  let n = 0, i = 0;
  while (n < cap) {
    const j = hay.indexOf(needle, i);
    if (j === -1) break;
    n++; i = j + needle.length;
  }
  return n;
}

// Figma-generated JSX only: React `className=` AND Figma's `data-node-id=` AND design-token
// `var(--…)`, each at least JSX_MIN_HITS times. All three together are what no hand-written HTML,
// XML or Liquid template carries — the corruption rail behind this stage.
function detectJsx(content) {
  const s = typeof content === 'string' ? content : '';
  if (s.includes(JSX_HEADER)) return false; // already compacted — never compact twice
  return countUpTo(s, 'data-node-id="', JSX_MIN_HITS) >= JSX_MIN_HITS &&
    countUpTo(s, 'className="', JSX_MIN_HITS) >= JSX_MIN_HITS &&
    countUpTo(s, 'var(--', JSX_MIN_HITS) >= JSX_MIN_HITS;
}

// Every `<prefix>value"` occurrence as { start, end, value }. Attribute values in this grammar are
// double-quoted and never contain an escaped quote, so the next `"` closes the value.
function scanAttr(text, prefix) {
  const out = [];
  let i = 0;
  for (;;) {
    const a = text.indexOf(prefix, i);
    if (a === -1) break;
    const vs = a + prefix.length;
    const ve = text.indexOf('"', vs);
    if (ve === -1) break; // unterminated → stop scanning, the tail stays verbatim
    out.push({ start: a, end: ve + 1, value: text.slice(vs, ve) });
    i = ve + 1;
  }
  return out;
}

// `var(--token,fallback)` spans, first `)` closing. A nested fallback (`var(--x, rgba(0,0,0,.5))`)
// simply tokenizes short; the leftover stays inline, so the legend still reconstructs byte-exactly.
function varTokens(s) {
  const out = [];
  let i = 0;
  for (;;) {
    const a = s.indexOf('var(--', i);
    if (a === -1) break;
    const b = s.indexOf(')', a);
    if (b === -1) break;
    out.push(s.slice(a, b + 1));
    i = b + 1;
  }
  return out;
}


const indentOf = (l) => { let i = 0; while (i < l.length && (l[i] === ' ' || l[i] === '\t')) i++; return i; };
const isDigit = (c) => c >= 48 && c <= 57;

// The value-carrying slots a repeated sibling may differ in. Everything else — tag names, class
// refs, structure, indentation — must match exactly, which is the conservative gate: an unequal
// class ref means a different appearance, so those siblings are kept in full.
const SLOT_ATTRS = [['data-node-id="', 'node-id'], ['data-name="', 'name'], ['alt="', 'alt'], ['src="', 'src']];

// Every slot leaves a MARK in the skeleton, so slot presence is part of the canon: `>text<` can
// never match `><`, and an own-line text node can never match a whitespace-only line at the same
// indent. That is what keeps a value-bearing line from folding into an empty one — two lines
// canonicalizing equal with different slot COUNTS would let the exemplar's list either hide the
// duplicates' extra values (silent loss under a "nothing dropped" header) or index past the end.
const SLOT_MARK = '\u0000';

// Split one line into a canonical skeleton (slot values replaced by their mark) + the slot values in
// document order. Two subtrees fold only when their skeletons are byte-equal.
function lineSlots(line, canon, slots) {
  // A Figma text node sits on its own line, so a whole prose-only line is one text slot — that is
  // what lets siblings differing ONLY in their copy fold with the copy listed. Anything carrying
  // markup or code punctuation stays structural. The slot value keeps the TRAILING whitespace too
  // (only the indent is canon), so repeats differing there are listed rather than silently equal.
  const t = line.trim();
  if (t && !/[<>{}=]/.test(t)) {
    const lead = line.length - line.trimStart().length;
    slots.push({ kind: 'text', value: line.slice(lead) });
    canon.push(line.slice(0, lead), SLOT_MARK, 'text', '\n');
    return;
  }
  const n = line.length;
  let i = 0;
  while (i < n) {
    const c = line[i];
    if (c === '#' && line[i + 1] === 'n' && isDigit(line.charCodeAt(i + 2))) {
      let j = i + 2;
      while (j < n && isDigit(line.charCodeAt(j))) j++;
      slots.push({ kind: 'node-id', value: line.slice(i, j) });
      canon.push(SLOT_MARK, 'node-id'); i = j; continue;
    }
    let matched = false;
    for (const [pre, kind] of SLOT_ATTRS) {
      if (!line.startsWith(pre, i)) continue;
      const ve = line.indexOf('"', i + pre.length);
      if (ve !== -1) { slots.push({ kind, value: line.slice(i + pre.length, ve) }); canon.push(pre, SLOT_MARK, kind, '"'); i = ve + 1; matched = true; }
      break;
    }
    if (matched) continue;
    // element text content (`>Finish<`) — the one slot that is not an attribute
    if (c === '>' && line[i + 1] !== '<') {
      const lt = line.indexOf('<', i + 1);
      if (lt > i + 1) {
        const txt = line.slice(i + 1, lt);
        if (txt.trim()) { slots.push({ kind: 'text', value: txt }); canon.push('>', SLOT_MARK, 'text'); i = lt; continue; }
      }
    }
    canon.push(c); i++;
  }
  canon.push('\n');
}

// Node-id refs are handed out in first-appearance order, so a folded subtree's ids are contiguous —
// collapse those runs to `#n120–#n158` instead of listing 39 refs. A slot carrying a `label` (a kind
// the subtree holds more than once) prints qualified, so `name#2:"B"` cannot be read as the outer
// `data-name`; node-id refs need no ordinal — each resolves to exactly one id in the map.
function fmtSlots(g) {
  const out = [];
  const num = (v) => (v.kind === 'node-id' && v.value[0] === '#' ? Number(v.value.slice(2)) : NaN);
  for (let i = 0; i < g.length; i++) {
    let j = i;
    while (j + 1 < g.length && Number.isFinite(num(g[j + 1])) && num(g[j + 1]) === num(g[j]) + 1) j++;
    if (j > i && Number.isFinite(num(g[i]))) { out.push(`${g[i].value}–${g[j].value}`); i = j; continue; }
    const v = g[i].kind === 'node-id' ? g[i].value : JSON.stringify(g[i].value);
    out.push(g[i].label ? `${g[i].label}:${v}` : v);
  }
  return out.join(', ');
}

// Fold adjacent same-shape siblings into the first one. Indentation is the tree: a node owns every
// following line indented deeper, plus its own closing tag. Only real elements fold (a line opening
// with `<`), only when the fold line is genuinely smaller than the lines it replaces, and the
// recursion never descends into a subtree that was folded away.
function foldSiblings(code) {
  const lines = code.split('\n');
  const drop = new Uint8Array(lines.length);
  const inject = new Map();
  let folded = 0;

  // Per-line skeleton and slots are built ONCE, and a line's skeleton is interned to an integer so a
  // subtree comparison is an id-array compare. Rebuilding a subtree's skeleton character by character
  // at every nesting level would instead cost bytes × depth — a deep tree stalls the caller.
  const canonId = new Int32Array(lines.length);
  const indent = new Int32Array(lines.length);
  const kind = new Uint8Array(lines.length); // 0 blank, 1 opening `<`, 2 closing `</`, 3 other
  const lineSlotList = new Array(lines.length);
  const intern = new Map();
  for (let i = 0; i < lines.length; i++) {
    const canon = [], slots = [];
    lineSlots(lines[i], canon, slots);
    const key = canon.join('');
    let id = intern.get(key);
    if (id === undefined) { id = intern.size + 1; intern.set(key, id); }
    canonId[i] = id;
    lineSlotList[i] = slots;
    indent[i] = indentOf(lines[i]);
    const t = lines[i].trim();
    kind[i] = !t ? 0 : (t.startsWith('</') ? 2 : (t[0] === '<' ? 1 : 3));
  }
  const sameShape = (a, b) => {
    const len = a[1] - a[0];
    if (len !== b[1] - b[0]) return false;
    for (let k = 0; k < len; k++) if (canonId[a[0] + k] !== canonId[b[0] + k]) return false;
    return true;
  };
  const nodeSlots = (r) => { const out = []; for (let i = r[0]; i < r[1]; i++) for (const s of lineSlotList[i]) out.push(s); return out; };

  const walk = (from, to) => {
    let d = -1;
    for (let i = from; i < to; i++) if (kind[i]) { d = indent[i]; break; }
    if (d === -1) return;
    const nodes = [];
    let i = from;
    while (i < to) {
      if (!kind[i] || indent[i] !== d) { i++; continue; }
      let j = i + 1;
      while (j < to && (!kind[j] || indent[j] > d)) j++;
      if (j < to && indent[j] === d && kind[j] === 2) j++;
      nodes.push([i, j]);
      i = j;
    }
    for (let g = 0; g < nodes.length;) {
      let h = g + 1;
      while (h < nodes.length && sameShape(nodes[g], nodes[h])) h++;
      if (h > g + 1 && kind[nodes[g][0]] === 1) {
        const base = nodeSlots(nodes[g]);
        const dups = [];
        for (let x = g + 1; x < h; x++) dups.push({ range: nodes[x], slots: nodeSlots(nodes[x]) });
        // Belt and braces on top of the slot marks: any residual skeleton ambiguity degrades to
        // "keep both siblings", never to a value that is neither listed nor emitted.
        if (dups.every((dd) => dd.slots.length === base.length)) {
          // A kind the subtree carries more than once is ambiguous unqualified — label those slots
          // with their ordinal so a listed value names the slot it came from.
          const seen = new Map();
          const ord = base.map((s) => { const k = (seen.get(s.kind) || 0) + 1; seen.set(s.kind, k); return k; });
          const varying = [];
          const kinds = [];
          for (let k = 0; k < base.length; k++) {
            if (!dups.some((dd) => dd.slots[k].value !== base[k].value)) continue;
            varying.push(k);
            if (!kinds.includes(base[k].kind)) kinds.push(base[k].kind);
          }
          const label = (k) => (base[k].kind !== 'node-id' && seen.get(base[k].kind) > 1 ? `${base[k].kind}#${ord[k]}` : null);
          const per = dups.map((dd) => `[${fmtSlots(varying.map((k) => ({ ...dd.slots[k], label: label(k) })))}]`).join(' ');
          const fold = `${' '.repeat(d)}{/* ×${dups.length} more, identical${kinds.length ? ` except (${kinds.join(', ')}): ${per}` : ''} */}`;
          let dropped = 0;
          for (const dd of dups) for (let x = dd.range[0]; x < dd.range[1]; x++) dropped += Buffer.byteLength(lines[x], 'utf8') + 1;
          if (Buffer.byteLength(fold, 'utf8') + 1 < dropped) {
            for (const dd of dups) for (let x = dd.range[0]; x < dd.range[1]; x++) drop[x] = 1;
            const at = nodes[g][1] - 1;
            inject.set(at, [...(inject.get(at) || []), fold]);
            folded += dups.length;
          }
        }
      }
      g = h;
    }
    for (const [s, e] of nodes) {
      if (drop[s]) continue; // a folded-away subtree has no surviving interior to fold
      const inner = (e - 1 > s && indent[e - 1] === d && kind[e - 1] === 2) ? e - 1 : e;
      if (inner > s + 1) walk(s + 1, inner);
    }
  };
  walk(0, lines.length);
  if (!folded) return { code, folded: 0 };
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!drop[i]) out.push(lines[i]);
    if (inject.has(i)) for (const f of inject.get(i)) out.push(f);
  }
  return { code: out.join('\n'), folded };
}


// Compact a Figma design-context payload. Returns `{ compressed, idFile, classes, nodeIds, folded }`
// — `compressed` is the original and `idFile` null unless the transforms produced a REAL byte win.
function compressJsx(content, part) {
  const text = String(content);
  try {
    const win = compactJsx(text, part);
    if (win) return win;
  } catch (_) {
    // A shape the transforms cannot handle degrades to passthrough — never a thrown stage.
  }
  return { compressed: text, idFile: null, classes: 0, nodeIds: 0, folded: 0 };
}

// The compaction itself: the win object, or null when there is nothing to reference or the compacted
// body is not smaller. `part(kind, payload)` registers the node-id map and returns the path to cite.
function compactJsx(text, part) {
  const cls = scanAttr(text, 'className="');
  const ids = scanAttr(text, 'data-node-id="');

  // Only values used more than once pay for themselves: a singleton would cost a legend line plus a
  // reference where the inline attribute was already shorter.
  const counts = new Map();
  for (const o of cls) counts.set(o.value, (counts.get(o.value) || 0) + 1);
  const dict = new Map();
  for (const o of cls) if (counts.get(o.value) >= 2 && !dict.has(o.value)) dict.set(o.value, `C${dict.size + 1}`);

  // The node-id map leaves the tree as a part the caller stores; `#n17` refs resolve through it.
  const idMap = new Map();
  let idFile = null;
  if (ids.length) {
    for (const o of ids) if (!idMap.has(o.value)) idMap.set(o.value, `n${idMap.size + 1}`);
    const map = {};
    for (const [full, ref] of idMap) map[ref] = full;
    idFile = part('ids', JSON.stringify(map));
  }
  if (!dict.size && !idMap.size) return null;

  // One left-to-right rewrite over both occurrence lists (they cannot overlap in this grammar, but
  // an occurrence starting inside a previous one is skipped rather than trusted).
  const occ = [];
  for (const o of cls) if (dict.has(o.value)) occ.push({ start: o.start, end: o.end, rep: `class=${dict.get(o.value)}` });
  if (idMap.size) for (const o of ids) occ.push({ start: o.start, end: o.end, rep: `#${idMap.get(o.value)}` });
  occ.sort((a, b) => a.start - b.start);
  const parts = [];
  let cursor = 0;
  for (const o of occ) {
    if (o.start < cursor) continue;
    parts.push(text.slice(cursor, o.start), o.rep);
    cursor = o.end;
  }
  parts.push(text.slice(cursor));

  const fold = foldSiblings(parts.join(''));

  // Legend pass 2: `var(--…)` tokens repeated ACROSS legend entries become `$N`. Skipped whole when
  // any entry already contains a `$`, so a `$N` reference can never be ambiguous.
  let entries = [...dict.keys()];
  const varLines = [];
  if (entries.length && !entries.some((e) => e.includes('$'))) {
    const tokCount = new Map();
    for (const e of entries) for (const t of varTokens(e)) tokCount.set(t, (tokCount.get(t) || 0) + 1);
    const chosen = new Map();
    for (const e of entries) for (const t of varTokens(e)) {
      if (chosen.has(t)) continue;
      const ref = `$${chosen.size + 1}`;
      // uses × saved-per-use must beat the legend line the token costs
      if (tokCount.get(t) * (t.length - ref.length) > t.length + ref.length + 3) chosen.set(t, ref);
    }
    if (chosen.size) {
      entries = entries.map((e) => {
        let out = '', i = 0;
        for (;;) {
          const a = e.indexOf('var(--', i);
          const b = a === -1 ? -1 : e.indexOf(')', a);
          if (b === -1) { out += e.slice(i); break; }
          const tok = e.slice(a, b + 1);
          out += e.slice(i, a) + (chosen.get(tok) || tok);
          i = b + 1;
        }
        return out;
      });
      for (const [t, ref] of chosen) varLines.push(`${ref}: ${t}`);
    }
  }

  // `ids=` and not `full=`: `full=<path>` names the ORIGINAL result, and a body carrying two `full=`
  // paths would let a loose scan hand back the id map instead of the payload.
  const legend = entries.map((e, i) => `C${i + 1}: ${e}`);
  const clauses = [];
  if (dict.size) clauses.push(`class=CN → the CN: legend line below${varLines.length ? ' ($N → the $N: line)' : ''}`);
  if (fold.folded) clauses.push('{/* ×N more … */} folds identical repeated siblings and lists what differed per repeat');
  // The map's path ends the header, ALWAYS, with no closing period: a read of the `ids=` token stops
  // at whitespace, so any clause or period after it would glue onto the filename.
  if (idMap.size) clauses.push(`#nN → a data-node-id, the full ids are in ids=${idFile}`);
  const tail = clauses.length ? ` ${clauses.join('; ')}` : '';
  const header = `${JSX_HEADER} Figma design context, compacted losslessly — nothing dropped.` +
    tail + (tail && !(idFile && tail.endsWith(idFile)) ? '.' : '');
  const compressed = [header, ...varLines, ...legend, '', fold.code].join('\n');
  if (Buffer.byteLength(compressed, 'utf8') >= Buffer.byteLength(text, 'utf8')) return null;
  return { compressed, idFile, classes: dict.size, nodeIds: idMap.size, folded: fold.folded };
}

// The engine entry. `ctx.part(kind, payload)` returns the path the header cites for the id map.
function run(text, opts, ctx) {
  if (!detectJsx(text)) return { decision: 'passthrough', reason: 'non-figma', text };
  const j = compressJsx(text, ctx.part);
  // One uninterruptible pass: a result that lands after the deadline is still discarded.
  if (ctx.deadline != null && Date.now() > ctx.deadline) return { decision: 'passthrough', reason: 'budget-exceeded', text };
  if (j.compressed === text || Buffer.byteLength(j.compressed, 'utf8') >= Buffer.byteLength(text, 'utf8')) {
    return { decision: 'passthrough', reason: 'no-gain', text };
  }
  return { decision: 'compressed', text: j.compressed, stages: ['jsx'] };
}

module.exports = { id: 'figma', run, detectJsx, compressJsx, foldSiblings, JSX_HEADER };
