/*
 * engines/jq.cjs — narrowing a JSON document by a small jq subset before an engine sees it.
 *
 * The grammar (no jq dependency; anything else is refused by name, never answered with a guess):
 *   expr   := term (',' term)*     — a multi-select answers with ONE array, one slot per term
 *   term   := path ('|' filter)*
 *   path   := dot path (`.a.b`, `.a[0]`, `.a.[0]`) with `[]` fan-out at any segment
 *   filter := 'keys' | 'length' | a leading-dot path (`.a | .b` ≡ `.a.b`)
 * Pure: the request's `jq` is narrowed here before sniff and the engine run.
 */
'use strict';

const { stripBom } = require('./util.cjs');
const { parseJsonl, unwrapFence, numberPrecisionLoss } = require('./json.cjs');

const GRAMMAR = "dot paths (.a.b, .a[0]), '[]' iteration, ',' multi-select, '| keys' / '| length'";
// Judged on the stage as typed, first, so whatever is left may be a plain key (`@type`, `a:b`, `2fa`).
const UNSUPPORTED = /\.\.|\/\/|\?|[()"']|[=<>!]=?|\[(?!\]|\d+\])[^\]]*\]?/;
// The separating dot is required after the first step, or `2fa` would split into `2`, `fa`.
const STEP = /^(\.?)([^.[\]]+)/;
const KEYS_SHOWN = 8;

const normalize = (p) => String(p).replace(/\[(\d+)\]/g, '.$1').replace(/^\.+/, '');

// What a walk could have addressed where it died: `keys: a, b` / `length: 3` / `value is string`.
function available(v) {
  if (Array.isArray(v)) return `length: ${v.length}`;
  if (v && typeof v === 'object') {
    const ks = Object.keys(v);
    if (!ks.length) return 'no keys (empty object)';
    return `keys: ${ks.slice(0, KEYS_SHOWN).join(', ')}${ks.length > KEYS_SHOWN ? `, …(+${ks.length - KEYS_SHOWN})` : ''}`;
  }
  return `value is ${v === null ? 'null' : typeof v}`;
}

// The first slice of a stage that is not supported syntax: the token a refusal names.
function badToken(s) {
  const t = String(s).trim();
  const m = /^(?:\.\.|\/\/|[A-Za-z_$][\w$-]*\s*\(|"[^"]*"?|'[^']*'?|\[[^\]]*\]?|[^\s,|]+)/.exec(t);
  if (!m) return t.slice(0, 40);
  // A bare word followed by more is refused for what follows: `length > 2` names `length > 2`.
  const bare = m[0] !== t && /^[A-Za-z_$][\w$-]*$/.test(m[0]);
  return (bare ? t : m[0]).slice(0, 40);
}

// One path stage → { segs } (a string key, or null for `[]`), or { bad }.
function parsePath(src) {
  const s = String(src).trim().replace(/\.\[/g, '[');
  if (/^\.?$/.test(s)) return { segs: [] };
  const out = UNSUPPORTED.exec(s);
  if (out) return { bad: out[0].slice(0, 40) };
  const segs = [];
  let rest = normalize(s);
  for (let first = true; rest; first = false) {
    if (rest.startsWith('[]')) { segs.push(null); rest = rest.slice(2); continue; }
    const m = STEP.exec(rest);
    if (!m || (m[1] === '.') === first) return { bad: badToken(rest) };
    segs.push(m[2]);
    rest = rest.slice(m[0].length);
  }
  return { segs };
}

/** parse(src) → { terms: [{ segs, ops }], identity } or { bad: '<token>' }. */
function parse(src) {
  if (/^\s*\.+\s*$/.test(String(src))) return { terms: [{ segs: [], ops: [] }], identity: true };
  const terms = [];
  for (const term of String(src).split(',')) {
    if (!term.trim()) return { bad: ',' };
    const stages = term.split('|');
    const head = parsePath(stages[0]);
    if (head.bad) return { bad: head.bad };
    const ops = [];
    for (const stage of stages.slice(1)) {
      const f = stage.trim();
      if (f === 'keys' || f === 'length') { ops.push(f); continue; }
      // A bare word after a pipe is a jq function (`add`, `not`), never a key.
      if (!f.startsWith('.')) return { bad: badToken(f || '|') };
      const p = parsePath(f);
      if (p.bad) return { bad: p.bad };
      ops.push(p.segs);
    }
    terms.push({ segs: head.segs, ops });
  }
  return { terms, identity: terms.length === 1 && !terms[0].ops.length && !terms[0].segs.length };
}

/** True when the parsed expression selects the whole document (`.`, `.[]`, `. | .`, `., .`): no narrowing. */
function whole(expr) {
  if (!expr || expr.bad) return false;
  if (expr.identity) return true;
  return expr.terms.every((t) => {
    if (t.ops.some((o) => typeof o === 'string')) return false;
    const flat = [].concat(t.segs, ...t.ops);
    return flat.length === 0 || (flat.length === 1 && flat[0] === null);
  });
}

function miss(what, where, cur) {
  const at = where.length ? `at '${where.join('.')}'` : 'at top level';
  return { ok: false, depth: where.length, diag: `jq: ${what} ${at}; ${available(cur)}` };
}

// One `[]` iteration; a hard failure stops it, a per-element miss is jq's null and rides on `miss`.
function fan(items, where, depth, apply) {
  const out = [];
  let n = 0;
  let dead = 0;
  let note = null;
  for (const item of items) {
    const r = apply(item);
    if (!r.ok) return r;
    n++;
    if (r.miss) { dead++; note = note || r.miss; }
    if (r.fan && Array.isArray(r.value)) { for (const x of r.value) out.push(x); } else out.push(r.value);
  }
  const res = { ok: true, value: out, where, depth, fan: true };
  if (n && dead === n) { res.allMissed = true; res.miss = note; }
  return res;
}

// Own members only: `.constructor` or `.length` names nothing in a JSON document.
function step(cur, seg) {
  if (cur === null || typeof cur !== 'object') return undefined;
  if (Array.isArray(cur)) return /^\d+$/.test(seg) ? cur[Number(seg)] : undefined;
  return Object.prototype.hasOwnProperty.call(cur, seg) ? cur[seg] : undefined;
}

function walk(root, segs, where0, lenient) {
  let cur = root;
  const where = where0.slice();
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (seg === null) {
      if (!cur || typeof cur !== 'object') return miss("'[]' needs an array or object", where, cur);
      const rest = segs.slice(i + 1);
      const inner = where.length ? where.slice(0, -1).concat(`${where[where.length - 1]}[]`) : ['[]'];
      return fan(Array.isArray(cur) ? cur : Object.values(cur), inner, where.length, (item) => walk(item, rest, inner, true));
    }
    const next = step(cur, seg);
    if (next === undefined) {
      if (!lenient) return miss(`'${seg}' not found`, where, cur);
      return { ok: true, value: null, where: where.concat(seg), miss: miss(`'${seg}' not found`, where, cur).diag };
    }
    where.push(seg);
    cur = next;
  }
  return { ok: true, value: cur, where };
}

// jq's own definitions of `keys` and `length`.
function filter(name, v, where) {
  if (name === 'keys') {
    if (Array.isArray(v)) return { ok: true, value: v.map((_, i) => i), where };
    if (v && typeof v === 'object') return { ok: true, value: Object.keys(v).sort(), where };
    return miss("'keys' needs an array or object", where, v);
  }
  const n = Array.isArray(v) ? v.length
    : v === null ? 0
      : typeof v === 'object' ? Object.keys(v).length
        : typeof v === 'string' ? [...v].length
          : typeof v === 'number' ? Math.abs(v) : null;
  if (n === null) return miss("'length' is not defined", where, v);
  return { ok: true, value: n, where };
}

// A filter after a fan-out applies per element: `.a[] | length` is N lengths.
function evalTerm(root, term) {
  let r = walk(root, term.segs, [], false);
  for (const op of term.ops) {
    if (!r.ok) return r;
    const apply = (v, lenient) => (typeof op === 'string' ? filter(op, v, r.where) : walk(v, op, r.where, lenient));
    if (!r.fan) { r = apply(r.value, false); continue; }
    r = fan(r.value, r.where, r.depth, (item) => apply(item, true));
  }
  return r;
}

/** evaluate(root, expr) → { ok, value, diags }: ok is false when no term resolved anything. */
function evaluate(root, expr) {
  const rs = expr.terms.map((t) => evalTerm(root, t));
  const dead = (r) => !r.ok || r.allMissed === true;
  const valueOf = (r) => (r.ok && r.value !== undefined ? r.value : null);
  return {
    ok: rs.some((r) => !dead(r)),
    value: rs.length === 1 ? valueOf(rs[0]) : rs.map(valueOf),
    diags: rs.filter(dead).map((r) => r.diag || r.miss).filter(Boolean),
  };
}

// The document a text holds: JSON, JSON lines as an array, or the JSON body of one dominant fence.
function documentOf(text) {
  const s = stripBom(String(text));
  try { return { value: JSON.parse(s), body: s }; } catch (_) {}
  const rows = parseJsonl(s);
  if (rows) return { value: rows, body: s };
  const f = unwrapFence(s);
  if (f) {
    try { return { value: JSON.parse(stripBom(f.body)), body: f.body }; } catch (_) {}
    const fr = parseJsonl(f.body);
    if (fr) return { value: fr, body: f.body };
  }
  return null;
}

/**
 * narrow(text, src) → the text a jq expression selects, before any engine runs.
 *   { decision: 'narrowed', text, value, diags }  text = JSON.stringify(value)
 *   { decision: 'whole' }                          the expression selects the whole document
 *   { decision: 'refused', reason, message }       reason ∈ jq-unsupported | jq-not-json |
 *                                                  number-precision | jq-miss
 */
function narrow(text, src) {
  const refuse = (reason, message) => ({ decision: 'refused', reason, message });
  const expr = parse(src);
  if (expr.bad) return refuse('jq-unsupported', `jq: unsupported syntax near '${expr.bad}' — supported: ${GRAMMAR}`);
  if (whole(expr)) return { decision: 'whole' };
  const doc = documentOf(text);
  if (!doc) return refuse('jq-not-json', 'jq: the source is not JSON or JSON lines');
  // A re-serialized value would carry rounded integers as if they were the source's.
  if (numberPrecisionLoss(doc.body)) return refuse('number-precision', 'jq: the source holds numbers JavaScript would round; narrowing would change them');
  const r = evaluate(doc.value, expr);
  if (!r.ok) return refuse('jq-miss', r.diags.join('\n') || 'jq: nothing matched');
  const value = r.value === undefined ? null : r.value;
  const out = JSON.stringify(value);
  if (typeof out !== 'string') return refuse('jq-miss', 'jq: nothing matched');
  return { decision: 'narrowed', text: out, value, diags: r.diags };
}

module.exports = { parse, whole, evaluate, narrow, GRAMMAR };
