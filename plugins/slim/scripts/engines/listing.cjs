/*
 * engines/listing.cjs — path lists (find, fd, git ls-files, rg --files, ls -R, tree) as a directory
 * outline.
 *
 * Input is parsed into one path set, a trie is built from it and printed top-down in input order
 * (an `ls -t` keeps its newest first): one line per
 * directory holding files (`<dir>/ (N files, M dirs)`), its files by bare name under it while the
 * directory has at most `threshold` files, else an extension histogram on that line
 * (`./assets/ (142 files): .liquid 61, .json 40 · e.g. a.liquid, b.json`). Depth is never cut; the
 * threshold falls instead (stages `listing` 8 → `fold4` 4 → `fold0` 0) until `targetBytes` holds. A
 * name is printed verbatim or counted, never rewritten; lines that are not paths (errors, tree's
 * summary, another command's `key=value` lines) stay verbatim under the header, and so does a bare
 * word without `/` or an extension (`2`, `none`) once the output holds such a line. Nothing folded
 * and the input within `targetBytes` → `no-gain`: a re-layout alone is the input again. Pure: no I/O.
 */
'use strict';

const { utf8, commas } = require('./util.cjs');

const MARK = '<<slim-listing>>';
const MIN_LINES = 50;
const STAGES = [['listing', 8], ['fold4', 4], ['fold0', 0]];
const EXAMPLES = 3;
const HIST_MAX = 8;
const SCAN_LINES = 2000;

const PATH = /^[^\s]+$/;
const TREE_BRANCH = /^((?:[│|]\s{3}|\s{4})*)(?:[├└]──|[|`]--)\s(.*)$/;
const LS_HEADER = /^(\S.*):$/;

const isPath = (l) => PATH.test(l) && !l.includes('://') && !l.startsWith('-') && !l.startsWith('```');
// An extension starts with a letter: `0.00`, `pkg==1.2.0` are values, not file names.
const hasShape = (l) => l.includes('/') || /[^./]\.[A-Za-z][\w-]{0,9}$/.test(l);
// CSV rows, key=value pairs and `grep -c` / `-printf '%p:%s'` counts carry values a fold would hide.
const DATA = /[,;=]|:\d+$/;
// A `key=value` line (`dir=/a/b`) is another command's output, never a path.
const KV = /^[\w-]+=/;

// The listing format of `lines` (non-blank, trimmed of \r), or null.
function formatOf(lines) {
  if (lines.length < MIN_LINES) return null;
  const scan = lines.slice(0, SCAN_LINES);
  const tree = scan.filter((l) => TREE_BRANCH.test(l)).length;
  if (tree / (scan.length - 1) >= 0.9) return 'tree';
  const paths = scan.filter(isPath);
  if (paths.length / scan.length < 0.9) return null;
  // ls -R entries are bare names: a `dir:` line among full paths is a file name, not a header.
  const headers = scan.filter((l) => LS_HEADER.test(l)).length;
  const nested = scan.filter((l) => !LS_HEADER.test(l) && l.slice(0, -1).includes('/')).length;
  if (headers && nested < scan.length * 0.1) return 'ls-R';
  if (paths.filter((l) => DATA.test(l)).length * 2 >= paths.length) return null;
  if (paths.filter(hasShape).length / paths.length < 0.5) return null;
  // Paths share their top directory; random text that happens to hold a `/` (base64) does not.
  const tops = new Map();
  const slashed = paths.filter((l) => l.slice(0, -1).includes('/')).map((l) => l.slice(0, l.indexOf('/')));
  for (const t of slashed) tops.set(t, (tops.get(t) || 0) + 1);
  return slashed.filter((t) => tops.get(t) > 1).length * 2 >= slashed.length ? 'flat' : null;
}

// → { format, entries: [{ segs, dir }], other: string[] } or null when the text is not a listing.
function parse(text) {
  const raw = text.split('\n').map((l) => l.replace(/\r$/, ''));
  const lines = raw.filter((l) => l.trim());
  const format = formatOf(lines);
  if (!format) return null;
  const entries = [];
  const other = [];
  const split = (p) => {
    if (p === '/') return { segs: [''], dir: true };
    const dir = p.endsWith('/');
    const segs = (dir ? p.slice(0, -1) : p).split('/');
    return { segs, dir };
  };
  if (format === 'tree') {
    // stack[d] = the segments of the open directory at depth d; stack[0] is the root.
    const stack = [];
    lines.forEach((l, i) => {
      const m = TREE_BRANCH.exec(l);
      if (!m) {
        // Any other line closes the tree; it opens the next one (`tree a "My Dir"`) when a depth-1 branch follows.
        stack.length = 0;
        const next = TREE_BRANCH.exec(lines[i + 1] || '');
        if (isPath(l) || (next && !next[1])) { stack.push(split(l).segs); entries.push({ segs: stack[0], dir: true }); } else other.push(l);
        return;
      }
      const depth = m[1].length / 4 + 1;
      if (stack.length < depth) { other.push(l); return; }
      stack.length = depth;
      const name = m[2];
      const parent = stack[depth - 1];
      // `tree -f` prints every name as a full path under its parent's.
      const segs = name.startsWith(`${parent.join('/')}/`) ? split(name).segs : [...parent, name.replace(/\/$/, '')];
      stack.push(segs);
      entries.push({ segs, dir: name.endsWith('/') });
    });
  } else if (format === 'ls-R') {
    // BSD `ls -R` prints the first directory's entries without a header: they belong to the parent of the first header.
    const first = raw.find((l, i) => (i === 0 || !raw[i - 1].trim()) && LS_HEADER.test(l));
    const parent = first ? LS_HEADER.exec(first)[1].replace(/\/$/, '').split('/').slice(0, -1).join('/') : '';
    let prefix = parent || null;
    let atStart = true;
    for (const l of raw) {
      if (!l.trim()) { atStart = true; continue; }
      const h = atStart ? LS_HEADER.exec(l) : null;
      atStart = false;
      if (h) { prefix = h[1].replace(/\/$/, ''); entries.push({ segs: split(prefix).segs, dir: true }); continue; }
      if (!isPath(l) && l.includes(': ')) { other.push(l); continue; }
      const name = l.length > 1 ? l.replace(/\/$/, '') : l;
      entries.push({ segs: prefix === null ? [name] : [...split(prefix).segs, name], dir: name !== l });
    }
  } else {
    const named = (l) => !KV.test(l) && (isPath(l) || (l.includes('/') && !l.includes(': ')));
    // A shapeless bare word (`gradlew`, a `find src` root) is a name unless another command's output sits beside it (`2`, `none`).
    const mixed = lines.some((l) => !named(l));
    for (const l of lines) {
      if (named(l) && (!mixed || !isPath(l) || hasShape(l))) entries.push(split(l));
      else other.push(l);
    }
  }
  return { format, entries, other };
}

function node(segs) {
  return { segs, kids: new Map(), files: [], explicitDir: false };
}

// Builds the trie; a node with children or written as a directory is a directory, every other leaf a file.
function trieOf(entries) {
  const root = node([]);
  for (const { segs, dir } of entries) {
    let n = root;
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      if (!n.kids.has(s)) n.kids.set(s, node(segs.slice(0, i + 1)));
      n = n.kids.get(s);
    }
    if (dir) n.explicitDir = true;
  }
  let dirs = 0;
  let files = 0;
  const walk = (n) => {
    for (const [name, k] of [...n.kids]) {
      if (k.kids.size || k.explicitDir) { dirs++; walk(k); } else { n.files.push(name); n.kids.delete(name); files++; }
    }
  };
  walk(root);
  return { root, dirs, files };
}

const label = (segs) => (segs.length === 1 && segs[0] === '' ? '/' : `${segs.join('/')}/`);
const extOf = (name) => { const i = name.lastIndexOf('.'); return i > 0 ? name.slice(i) : '(none)'; };
const plural = (n, word) => `${commas(n)} ${word}${n === 1 ? '' : 's'}`;

// A folded directory's file summary: extension histogram, then up to `examples` names (input order), one per top extension first.
function histogram(files, examples) {
  const by = new Map();
  for (const f of files) { const e = extOf(f); if (!by.has(e)) by.set(e, []); by.get(e).push(f); }
  const exts = [...by].sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1));
  const shown = exts.slice(0, HIST_MAX).map(([e, fs]) => `${e} ${commas(fs.length)}`);
  const rest = exts.slice(HIST_MAX).reduce((n, [, fs]) => n + fs.length, 0);
  if (rest) shown.push(`other ${commas(rest)}`);
  const eg = [];
  for (let round = 0; eg.length < examples && round < examples; round++) {
    for (const [, fs] of exts) { if (eg.length < examples && fs[round] !== undefined) eg.push(fs[round]); }
  }
  return `${shown.join(', ')}${eg.length ? ` · e.g. ${eg.join(', ')}` : ''}`;
}

// The outline at one threshold → { body: string[], folded: files hidden, foldedDirs }, or null past the deadline.
// Threshold 0 is the histogram-only outline: every directory folds, without example names.
function render(trie, threshold, deadline) {
  const body = [];
  let folded = 0;
  let foldedDirs = 0;
  let n = 0;
  const visit = (d) => {
    if (deadline != null && ++n % 512 === 0 && Date.now() > deadline) return false;
    const kids = [...d.kids.keys()];
    if (d.files.length || (d.segs.length && !kids.length)) {
      const counts = d.files.length || kids.length ? `${plural(d.files.length, 'file')}${kids.length ? `, ${plural(kids.length, 'dir')}` : ''}` : 'empty';
      const head = `${d.segs.length ? label(d.segs) : '(top level)'} (${counts})`;
      const full = [head, ...d.files.map((f) => `  ${f}`)];
      const hist = d.files.length > threshold ? `${head}: ${histogram(d.files, threshold ? EXAMPLES : 0)}` : null;
      if (hist !== null && (!threshold || utf8(hist) < utf8(full.join('\n')))) { body.push(hist); folded += d.files.length; foldedDirs++; } else body.push(...full);
    }
    for (const k of kids) if (!visit(d.kids.get(k))) return false;
    return true;
  };
  return visit(trie.root) ? { body, folded, foldedDirs } : null;
}

function compose(p, trie, r) {
  const paths = new Set(p.entries.map((e) => e.segs.join('/'))).size;
  const header = `${MARK} ${p.format} · ${plural(paths, 'path')} · ${plural(trie.files, 'file')} in ${plural(trie.dirs, 'dir')}` +
    ` · ${commas(r.folded)} files folded in ${plural(r.foldedDirs, 'dir')} · shown ${plural(r.body.length, 'line')}`;
  const footer = 'a folded name → rerun narrower (`find <dir> -name \'<pattern>\'`, `ls <dir>`) or Read the original with offset/limit';
  return [header, ...p.other, ...r.body, footer].join('\n');
}

// The engine entry: lowers the fold threshold only as far as targetBytes asks.
function run(text, opts, ctx) {
  const deadline = ctx && ctx.deadline != null ? ctx.deadline : null;
  const late = () => deadline != null && Date.now() > deadline;
  if (late()) return { decision: 'passthrough', reason: 'budget-exceeded', text };
  const p = parse(text);
  if (!p) return { decision: 'passthrough', reason: 'non-listing', text };
  const trie = trieOf(p.entries);
  const inBytes = utf8(text);
  const target = opts && opts.targetBytes ? opts.targetBytes : null;
  const stages = [];
  let out = null;
  let r = null;
  for (const [stage, threshold] of STAGES) {
    r = render(trie, threshold, deadline);
    if (r === null || late()) return { decision: 'passthrough', reason: 'budget-exceeded', text };
    stages.push(stage);
    out = compose(p, trie, r);
    if (target === null || utf8(out) <= target) break;
  }
  if ((!r.folded && !(target !== null && inBytes > target)) || utf8(out) >= inBytes) return { decision: 'passthrough', reason: 'no-gain', text };
  return { decision: 'compressed', text: out, stages };
}

// sniff's check: the listing format of the first 64 KB, or null.
const detect = (text) => formatOf(text.slice(0, 65536).split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.trim()));

module.exports = { id: 'listing', run, parse, detect, MARK };
