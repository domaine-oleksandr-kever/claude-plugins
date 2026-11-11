#!/usr/bin/env node
// drafter-check.cjs — checks a drafter's file and its receipt in code, so the main session never
// reads the draft. Prints counts and `ok`/`fail` lines only, never the checked text.
//
//   drafter-check.cjs file stt <path> [--refs <dir>]  steps-to-test.md: the four items as one list; no
//                                                expectation, old-format text or handle; the preview link
//                                                bare (no code span, no [label](url)); every DevTools >
//                                                Network panel mention names its filter (the Network
//                                                request blocking / conditions drawers are no panel); every DevTools >
//                                                Elements mention names its attribute or selector in a
//                                                code span; words (warn=over-160 above 160,
//                                                warn=over-120-target from 121 to 160), attribution; with --refs
//                                                (base references/steps-to-test), no 8-word run of a
//                                                quoted reference example of 8+ words; with
//                                                --project-rules <file> (the project's local
//                                                .claude/domaine/steps-to-test.md), its frontmatter:
//                                                item 1's environment and a listed host, no unlisted
//                                                host, bare page links (a catalog path) on item 1's
//                                                hosts in items 2–3 (required with
//                                                `links: required` unless --no-page-link)
//   drafter-check.cjs rules <file> [--prose]     a project rules file's frontmatter, parsed and printed;
//                                                --prose adds its prose part after a `prose:` line
//   drafter-check.cjs rules-path [--cwd <dir>]   which project rules file applies: this tree's, else the
//                                                main checkout's when this is a linked worktree, else
//                                                none; keeps it out of git (info/exclude) or warns
//   drafter-check.cjs file pr <path> [--no-preview]  pr-body.md: core skeleton, theme preview table
//                                                (off with --no-preview when the notes.md beside it
//                                                records 'preview-decision: no preview'), None/N/A,
//                                                Summary, attribution
//   drafter-check.cjs file jira <path> [--table]  jira-comment.md: PR line, bulleted brief, no preview link,
//                                                attribution; a GFM table fails, except with --table (the
//                                                developer asked for one): then its rows are no brief lines
//   drafter-check.cjs receipt stt|pr|jira        the drafter's reply on stdin: one kind, no empty field;
//                                                stt: `ac: empty` and a non-empty `ac_proposal:` come together;
//                                                `page_links: none — <why>` and `pages_needed:` never together
//
// First stdout line: result=ok|fail (rules-path: rules=…). Exit 0 ok, 1 fail, 2 usage; rules-path exits 0.
'use strict';
const fs = require('fs');
const nodePath = require('path');
const { spawnSync } = require('child_process');

const USAGE = `usage: drafter-check.cjs file stt <path> [--refs <dir>] [--project-rules <file> [--no-page-link]]
       drafter-check.cjs rules <file> [--prose]
       drafter-check.cjs rules-path [--cwd <dir>]
       drafter-check.cjs file pr <path> [--no-preview]   (--theme: accepted, no-op)
       drafter-check.cjs file jira <path> [--table]
       drafter-check.cjs receipt stt|pr|jira   (the drafter's reply on stdin)
The pr check requires the Theme preview table; --no-preview turns that off only when the notes.md
beside the checked file holds a 'preview-decision: no preview' line (the developer's recorded
answer) — else the table is still required. Prints no_preview=recorded|unrecorded|off.
The stt check never fails on words: it prints warn=over-120-target from 121 to 160 and warn=over-160
above 160 (still ok).
--refs <dir> (an existing dir of *.md) fails a field holding 8 consecutive words of a "quoted" example
of 8+ words from those files; prints examples=<n checked>, else examples=skipped.
--project-rules <file> applies the project's Steps to Test rules (base references/steps-to-test/
project-rules.md): an environment word in item 1 the file does not allow fails, an item 1 naming none of
its hosts fails, a page link or *.myshopify.com host outside its stores fails, a page link (a
/products|collections|pages|blogs/<handle> URL) on its hosts in items 2–3 is no handle but fails in a
code span, behind [label](url) or on a host item 1 does not name,
theme: published fails a preview link, and links: required fails a field with no page link on its
hosts — unless --no-page-link (the receipt's 'page_links: none — <why>'). A malformed file fails
with 'fail project rules: <reason>'; 'rules <file>' prints the parsed values only, and with --prose
then a 'prose:' line and the file's prose part verbatim ('prose: none' when it has none).
rules-path finds the project rules file, stopping at the first that exists: <project root>/.claude/
domaine/steps-to-test.md in this tree, then the same path in the main checkout when this tree is a
linked git worktree. It prints one line, 'rules=tree path=<abs>', 'rules=main path=<abs>' or
'rules=none' (also outside git), and for a found file at most one more line: 'warn=rules_tracked
path=<abs>' when git tracks it; 'excluded=.claude/domaine/steps-to-test.md exclude=<abs>' when it was
untracked and not ignored, that line went into the repo's local info/exclude and git now ignores it;
'warn=rules_not_ignored reason=check_ignore_failed|exclude_unwritable|gitignore_reincludes path=<abs>'
when it is untracked and still not ignored. Exit 0 whatever it finds.
The jira check fails a GFM table (a pipe row over a --- separator row, as base md-to-adf.cjs reads
one); --table, only when the developer asked for a table in the comment, takes its rows out of the
brief's line count and bullet check. Prints tables=<n>.
Prints result=ok|fail, counts and one 'fail <check>' line per defect — never the checked text.
Exit 0 ok, 1 fail, 2 usage.`;

// ported from base hooks/mods/guards/attribution.ts — keep in sync
const ATTRIBUTION =
  /co-authored-by:[^<>]*(claude|anthropic|<[^<>]*@([A-Za-z0-9-]+\.)*anthropic\.com)|noreply@anthropic\.com|generated with \[?claude/i;

const attributionHits = (text) => text.split('\n').filter((l) => ATTRIBUTION.test(l)).length;

function report(lines, fails) {
  process.stdout.write([`result=${fails.length ? 'fail' : 'ok'}`, ...lines, ...fails.map((f) => `fail ${f}`)].join('\n') + '\n');
  return fails.length ? 1 : 0;
}

function readFile(path, fails) {
  let text = '';
  try { text = fs.readFileSync(path, 'utf8'); } catch (e) { fails.push('file missing'); return null; }
  if (!text.trim()) { fails.push('file empty'); return null; }
  return text;
}

// base references/steps-to-test/templates.md: the four items, in order
const STT_ITEMS = [['Theme', /^1\. \*\*Theme:\*\*/], ['Object', /^2\. \*\*Object:\*\*/], ['Setup', /^3\. \*\*Setup:\*\*/],
  ['Edge cases / not obvious', /^4\. \*\*Edge cases \/ not obvious:\*\*/]];
const STT_TARGET_WORDS = 120;
const STT_MAX_WORDS = 160;
const EXPECTATION = /\bshould (?:now )?(?:see|show|display|appear)\b|\byou(?:'ll| will) see\b|\bexpected(?: results?)?\s*:|\bexpected results?\b|\bresult\s*:|\bverify\b|\bconfirm that\b/i;
const OLD_FORMAT = /handles are examples|why the bug happened|what was changed|what to expect|context \/ out of scope|\bregression:|\balready (?:set up|configured)\b/i;
// a catalog handle: a concrete /products|collections|pages|blogs/<handle> path, `e.g.` followed by a path,
// or `e.g.` followed by a kebab-case word in backticks; the bare `/collections/…` placeholder is no handle,
// nor is a /pages/<x> whose templates/page.<x>.json|liquid the theme repo ships (a page type, not catalog data),
// nor Shopify's built-in /collections/all (a page type; /collections/all-foo stays a handle)
const HANDLE = /\/(?:products|collections|pages|blogs)\/[A-Za-z0-9]|\be\.g\.,?\s*[`'"(]?\/|\be\.g\.,?\s*`[a-z0-9]+(?:-[a-z0-9]+)+`/i;
const PAGE_PATH = /\/pages\/([A-Za-z0-9][\w-]*)/gi;
const ALL_COLLECTION = /\/collections\/all(?![\w-])/gi;
// the DevTools Network panel; More tools > Network request blocking / Network conditions are drawers with no filter
const NETWORK_PANEL = /\bNetwork\b(?!\s+(?:[Rr]equest\s+[Bb]locking|[Cc]onditions)\b)/;

/** The <x> of every templates/page.<x>.json|liquid under the cwd and the nearest ancestor of an absolute `path` holding templates/. */
function pageTemplates(path) {
  const dirs = [nodePath.resolve('templates')];
  for (let d = nodePath.dirname(path); nodePath.isAbsolute(path); d = nodePath.dirname(d)) {
    if (fs.existsSync(nodePath.join(d, 'templates'))) { dirs.push(nodePath.join(d, 'templates')); break; }
    if (d === nodePath.dirname(d)) break;
  }
  const out = new Set();
  for (const dir of dirs) {
    try { for (const n of fs.readdirSync(dir)) { const m = /^page\.(.+)\.(?:json|liquid)$/i.exec(n); if (m) out.add(m[1].toLowerCase()); } } catch (e) { /* no templates dir */ }
  }
  return out;
}

// a preview link (`preview_theme_id=<digits>`, any host form) in a code span of any backtick run, or
// behind a [label](url): neither is clickable in Jira; a store host or the bare parameter name may be code
const CODE_SPAN = /(`+)(.+?)(?<!`)\1(?!`)/g;
const PREVIEW_ID = /preview_theme_id=\d/i;
const notBareLink = (l) => [...l.matchAll(CODE_SPAN)].some((m) => PREVIEW_ID.test(m[2]))
  || /\[[^\]]*\]\([^)]*preview_theme_id/i.test(l);

/** Words a reader reads: list markers and tokens with no letter or digit (`>`, `—`) are not words. */
const wordCount = (lines) => lines
  .map((l) => l.replace(/^\s*(?:\d+\.|[-*+])\s+/, ''))
  .join(' ').split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

// a reference example: a straight-double-quoted string outside code spans, of EXAMPLE_WORDS words or more
const EXAMPLE_WORDS = 8;
/** Lowercased words, markdown emphasis, backticks and edge punctuation stripped. */
const exampleWords = (text) => text.toLowerCase().replace(/\*\*|`/g, '').split(/\s+/)
  .map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')).filter(Boolean);

/** Every quoted example of EXAMPLE_WORDS+ words in the *.md files of `dir`, as word arrays. */
function refExamples(dir) {
  const out = [];
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.md')).sort()) {
    const text = fs.readFileSync(nodePath.join(dir, f), 'utf8').replace(CODE_SPAN, ' ').replace(/\s+/g, ' ');
    for (const m of text.matchAll(/"([^"]+)"/g)) {
      const w = exampleWords(m[1]);
      if (w.length >= EXAMPLE_WORDS) out.push(w);
    }
  }
  return out;
}

/** The first example of `examples` an EXAMPLE_WORDS-word run of which the field holds, or null. */
function copiedExample(lines, examples) {
  const field = ` ${exampleWords(lines.map((l) => l.replace(/^\s*(?:\d+\.|[-*+])\s+/, '')).join(' ')).join(' ')} `;
  return examples.find((w) => w.slice(0, w.length - EXAMPLE_WORDS + 1)
    .some((_, i) => field.includes(` ${w.slice(i, i + EXAMPLE_WORDS).join(' ')} `))) || null;
}

// base references/steps-to-test/project-rules.md: the frontmatter keys a project rules file may hold
const RULE_KEYS = ['environment', 'theme', 'links', 'stores'];
const ENVIRONMENTS = { dev: 'DEV', uat: 'UAT', prod: 'Prod', production: 'Prod' };
const ENV_WORD = /\b(dev|uat|prod|production)\b/gi;
const LINKS = ['required', 'optional', 'off'];
const PAGE_URL = /https?:\/\/([A-Za-z0-9.-]+)(?::\d+)?([^\s)\]>`'"]*)/g;
const MYSHOPIFY = /\b[a-z0-9][a-z0-9-]*\.myshopify\.com\b/gi;
const CATALOG_PATH = /^\/(?:products|collections|pages|blogs)\//i;
const MD_LINK = /\[[^\]]*\]\(([^)]*)\)/g;
/** `host` named in `line` as a whole host, not as part of a longer one. */
const hostIn = (line, host) => new RegExp(`(?<![\\w.-])${host.replace(/[.]/g, '\\.')}(?![\\w-])`, 'i').test(line);
const unquote = (s) => s.trim().replace(/^(["'])(.*)\1$/, '$2').trim();
const normHost = (h) => unquote(h).toLowerCase().replace(/^https?:\/\//, '').replace(/[/?#:].*$/, '').replace(/\.$/, '');

/** The `---` frontmatter of `text` as { key: string | (string | object)[] }; `#` comments dropped. Throws on a line it cannot place. */
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
function frontmatter(text) {
  const m = FRONTMATTER.exec(text);
  if (!m) throw new Error('no --- frontmatter at the top of the file');
  const out = {};
  let key = null;
  m[1].split(/\r?\n/).forEach((raw, i) => {
    const l = raw.replace(/(^|\s)#.*$/, '').replace(/\s+$/, '');
    if (!l.trim()) return;
    let f = /^([a-z][\w-]*):\s*(.*)$/.exec(l);
    if (f) {
      key = f[1];
      if (key in out) throw new Error(`${key}: given twice`);
      out[key] = f[2] === '' ? [] : f[2];
      return;
    }
    const list = key !== null && Array.isArray(out[key]) ? out[key] : null;
    const last = list && list[list.length - 1];
    if ((f = /^\s*-\s+(.*)$/.exec(l)) && list) {
      const kv = /^([a-z][\w-]*):\s*(.*)$/.exec(f[1]);
      list.push(kv ? { [kv[1]]: kv[2] } : f[1]);
      return;
    }
    if ((f = /^\s+([a-z][\w-]*):\s*(.*)$/.exec(l)) && last && typeof last === 'object' && !(f[1] in last)) { last[f[1]] = f[2]; return; }
    throw new Error(`frontmatter line ${i + 2} is not \`key: value\`, \`- item\` or a field of the entry above`);
  });
  return out;
}

/** A project rules file (base references/steps-to-test/project-rules.md), normalised to { environments: string[]|null, theme: 'published'|null, links, stores: [{brand, store, host}] }. Throws Error('<key>: <reason>') on a missing file, an unknown key, an empty or malformed value. */
function projectRules(path) {
  let text;
  try { text = fs.readFileSync(path, 'utf8'); } catch (e) { throw new Error('file missing'); }
  const fm = frontmatter(text);
  const unknown = Object.keys(fm).filter((k) => !RULE_KEYS.includes(k));
  if (unknown.length) throw new Error(`unknown key ${unknown[0]} (keys: ${RULE_KEYS.join(', ')})`);
  if (!RULE_KEYS.some((k) => k in fm)) throw new Error(`no rule key (${RULE_KEYS.join(', ')})`);
  const one = (k) => {
    const v = fm[k];
    if (v === undefined) return null;
    if (typeof v !== 'string' || !unquote(v)) throw new Error(`${k}: empty or not one value`);
    return unquote(v).toLowerCase();
  };
  const r = { environments: null, theme: one('theme'), links: one('links') || 'off', stores: [] };
  if (r.theme !== null && r.theme !== 'published') throw new Error(`theme: "${r.theme}" is not published`);
  if (!LINKS.includes(r.links)) throw new Error(`links: "${r.links}" is not ${LINKS.join(', ')}`);
  if ('environment' in fm) {
    const v = fm.environment;
    const raw = (Array.isArray(v) ? v : splitOptions(v) || [v]).map((x) => (typeof x === 'string' ? unquote(x) : ''));
    if (!raw.length || raw.some((x) => !x)) throw new Error('environment: empty');
    r.environments = [...new Set(raw.map((x) => {
      if (!ENVIRONMENTS[x.toLowerCase()]) throw new Error(`environment: "${x}" is not DEV, UAT or Prod`);
      return ENVIRONMENTS[x.toLowerCase()];
    }))];
  }
  if ('stores' in fm) {
    const v = fm.stores;
    if (!Array.isArray(v) || !v.length || v.some((e) => typeof e !== 'object')) throw new Error('stores: empty or not a list of `- brand: / store: / host:` entries');
    r.stores = v.map((e, i) => {
      const bad = Object.keys(e).find((k) => !['brand', 'store', 'host'].includes(k));
      if (bad) throw new Error(`stores entry ${i + 1}: unknown field ${bad} (brand, store, host)`);
      if (!e.host || !unquote(e.host)) throw new Error(`stores entry ${i + 1}: host missing`);
      const host = normHost(e.host);
      if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(host)) throw new Error(`stores entry ${i + 1}: host "${unquote(e.host)}" is not a storefront host`);
      return { brand: e.brand ? unquote(e.brand) : '', store: e.store ? unquote(e.store) : '', host };
    });
  }
  if (r.links !== 'off' && !r.stores.length) throw new Error(`stores: missing (links: ${r.links} needs the allowed hosts)`);
  return r;
}

/** `rules <file> [--prose]`: the parsed values of a project rules file, or its named error; `prose` adds the text below its frontmatter. */
function checkRules(path, prose) {
  let r;
  try { r = projectRules(path); } catch (e) { return report(['rules=invalid'], [`project rules: ${e.message}`]); }
  const rc = report([`environment=${r.environments ? r.environments.join(',') : 'any'}`, `theme=${r.theme || 'general'}`,
    `links=${r.links}`, `stores=${r.stores.length}`, `hosts=${r.stores.map((s) => s.host).join(',') || '-'}`], []);
  if (prose) {
    const body = fs.readFileSync(path, 'utf8').replace(FRONTMATTER, '').replace(/^\s*\n/, '').replace(/\s+$/, '');
    process.stdout.write(body ? `prose:\n${body}\n` : 'prose: none\n');
  }
  return rc;
}

// base references/steps-to-test/project-rules.md: the project rules file, relative to a checkout's root
const RULES_REL = '.claude/domaine/steps-to-test.md';

/** `git -C <dir> <args>`: { status, out } with stdout trimmed; status null when git cannot run. */
function git(dir, args) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return { status: r.status, out: (r.stdout || '').trim() };
}
const real = (p) => { try { return fs.realpathSync(p); } catch (e) { return null; } };
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } };

/** The main checkout of the linked worktree at `top`, or null (not a linked worktree, a bare or odd common dir). */
function mainCheckout(top) {
  const common = git(top, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const own = git(top, ['rev-parse', '--path-format=absolute', '--git-dir']);
  if (common.status !== 0 || own.status !== 0 || !common.out || real(common.out) === real(own.out)) return null;
  if (nodePath.basename(common.out) !== '.git') return null;
  const main = nodePath.dirname(common.out);
  const t = git(main, ['rev-parse', '--show-toplevel']);
  return t.status === 0 && real(t.out) === real(main) ? main : null;
}

/** `rules-path [--cwd <dir>]`: the project rules file this tree uses, kept out of git; always 0. */
function rulesPath(cwd) {
  const say = (lines) => { process.stdout.write(lines.join('\n') + '\n'); return 0; };
  const top = git(cwd, ['rev-parse', '--show-toplevel']);
  if (top.status !== 0 || !top.out) return say(['rules=none']);
  let from = 'tree';
  let root = top.out;
  if (!isFile(nodePath.join(root, RULES_REL))) {
    const main = mainCheckout(root);
    if (!main || !isFile(nodePath.join(main, RULES_REL))) return say(['rules=none']);
    from = 'main';
    root = main;
  }
  const file = nodePath.join(root, RULES_REL);
  const lines = [`rules=${from} path=${file}`];
  if (git(root, ['ls-files', '--error-unmatch', '--', RULES_REL]).status === 0) return say([...lines, `warn=rules_tracked path=${file}`]);
  const notIgnored = (reason) => say([...lines, `warn=rules_not_ignored reason=${reason} path=${file}`]);
  const ignored = () => git(root, ['check-ignore', '-q', '--', RULES_REL]).status;
  const before = ignored();
  if (before === 0) return say(lines);
  const common = git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (before !== 1 || common.status !== 0 || !common.out) return notIgnored('check_ignore_failed');
  const exclude = nodePath.join(common.out, 'info', 'exclude');
  let wrote = false;
  try {
    let text = '';
    try { text = fs.readFileSync(exclude, 'utf8'); } catch (e) { fs.mkdirSync(nodePath.dirname(exclude), { recursive: true }); }
    if (!text.split(/\r?\n/).some((l) => l.trim() === RULES_REL || l.trim() === `/${RULES_REL}`)) {
      fs.appendFileSync(exclude, `${text && !text.endsWith('\n') ? '\n' : ''}${RULES_REL}\n`);
      wrote = true;
    }
  } catch (e) { return notIgnored('exclude_unwritable'); }
  // a re-including .gitignore pattern outranks info/exclude
  if (!wrote || ignored() !== 0) return notIgnored('gitignore_reincludes');
  return say([...lines, `excluded=${RULES_REL} exclude=${exclude}`]);
}

/** Steps to Test: the structural rules of base references/steps-to-test/{templates,shape-and-size,self-check}.md a script can see, plus a project rules file's when `rules` is given. */
function checkStt(path, refs, rulesPath, noPageLink) {
  const fails = [];
  let rules = null;
  if (rulesPath) {
    try { rules = projectRules(rulesPath); } catch (e) { return report(['kind=stt', 'rules=invalid'], [`project rules: ${e.message}`]); }
  }
  const text = readFile(path, fails);
  const examples = refs ? refExamples(refs) : null;
  const ex = examples ? `examples=${examples.length}` : 'examples=skipped';
  if (text === null) return report(['kind=stt', ex], fails);
  const lines = text.split('\n');
  let cur = 0;
  const itemAt = lines.map((l) => { const t = /^(\d+)\. /.exec(l); if (t) cur = Number(t[1]); return cur; });
  const hosts = new Set(rules ? rules.stores.map((s) => s.host) : []);
  const linking = rules && rules.links !== 'off';
  const storeLink = (t) => [...t.matchAll(PAGE_URL)].some((m) => hosts.has(m[1].toLowerCase()) && CATALOG_PATH.test(m[2]));
  const pageLink = (i, host, path) => linking && (itemAt[i] === 2 || itemAt[i] === 3) && hosts.has(host.toLowerCase()) && CATALOG_PATH.test(path);
  const linkFree = (l, i) => (linking ? l.replace(PAGE_URL, (m, h, p) => (pageLink(i, h, p) ? ' ' : m)) : l);
  const first = lines.find((l) => l.trim()) || '';
  if (!STT_ITEMS[0][1].test(first)) fails.push('item 1 is not the **Theme:** line');
  STT_ITEMS.slice(1).forEach(([name, re]) => { if (!lines.some((l) => re.test(l))) fails.push(`item missing: ${name}`); });
  const nums = lines.map((l) => (/^(\d+)\. /.exec(l) || [])[1]).filter(Boolean).map(Number);
  if (nums.some((n, i) => n !== i + 1)) fails.push('items not numbered through from 1');
  if (nums.length !== STT_ITEMS.length) fails.push(`not ${STT_ITEMS.length} items (${nums.length})`);
  let item = 0;
  const nested = new Set();
  const indents = [];
  let stray = false;
  let subList = false;
  for (const l of lines) {
    const top = /^(\d+)\. /.exec(l);
    if (top) { item = Number(top[1]); continue; }
    const bullet = /^(\s+)(?:[-*+]|\d+\.) /.exec(l);
    if (bullet) {
      if (item !== 3 && item !== 4) nested.add(item);
      indents.push(bullet[1].length);
      if (/^\s+\d+\. /.test(l)) subList = true;
    } else if (l.trim()) {
      stray = true;
    }
  }
  nested.forEach((n) => fails.push(n ? `nested bullet under item ${n} (only under items 3 and 4)` : 'nested bullet before item 1'));
  if (indents.length && Math.max(...indents) > Math.min(...indents)) fails.push('bullet nested more than one level');
  if (subList) fails.push('numbered sub-list in the field (a walk-through; setup bullets are `-`)');
  if (stray) fails.push('line outside the list (a wrapped line, a column-0 bullet, an image or a block): one physical line per item and per indented bullet');
  if (lines.some((l) => /^#{1,6} /.test(l))) fails.push('heading in the field');
  if (lines.some((l) => /^\s*\|.*\|\s*$/.test(l))) fails.push('table in the field');
  if (text.includes('✅')) fails.push('✅ marker in the field');
  if (/<\/?(?:details|summary)\b/i.test(text)) fails.push('accordion in the field (<details> / <summary>)');
  if (/!\[[^\]]*\]\(/.test(text)) fails.push('image in the field (the developer attaches setup screenshots after item 4 by hand)');
  if (lines.some((l) => EXPECTATION.test(l))) fails.push('expected result in the field ("should see", "Expected:", "verify")');
  if (lines.some((l) => OLD_FORMAT.test(l))) fails.push('old-format text in the field (handle substitution, Bug-template label, context item, "already set up")');
  const pages = pageTemplates(path);
  const unbound = (l) => l.replace(PAGE_PATH, (m, x) => (pages.has(x.toLowerCase()) ? '/pages/…' : m)).replace(ALL_COLLECTION, '/collections/…');
  if (lines.some((l, i) => HANDLE.test(unbound(linkFree(l, i))))) fails.push('catalog handle in the field (data as properties, never a handle; a /pages/<x> with templates/page.<x>.json is a page type)');
  if (lines.some(notBareLink)) fails.push('preview link not bare (a code span or [label](url) is not clickable in Jira)');
  if (lines.some((l) => NETWORK_PANEL.test(l) && !/\bfilter\b/i.test(l))) fails.push('Network without its filter (every DevTools > Network mention names filter Fetch/XHR, Img, Doc …)');
  if (lines.some((l) => /DevTools\s*>\s*Elements\b|\bElements (panel|tab)\b/.test(l) && !l.includes('`'))) fails.push('Elements without its attribute (every DevTools > Elements mention names the attribute or selector it points at, in a code span)');
  const copied = examples && copiedExample(lines, examples);
  if (copied) fails.push(`example copied from the references: "${copied.slice(0, 6).join(' ')}…" (write the fact from this ticket's sources)`);
  const ruled = [];
  if (rules) {
    const allowed = rules.environments;
    if (allowed) {
      const said = new Set(lines.filter((l, i) => itemAt[i] === 1).flatMap((l) => [...l.matchAll(ENV_WORD)].map((m) => ENVIRONMENTS[m[1].toLowerCase()])));
      [...said].filter((e) => !allowed.includes(e)).forEach((e) => fails.push(`environment ${e} in item 1 (the project rules allow ${allowed.join(', ')} only)`));
      if (![...said].some((e) => allowed.includes(e))) fails.push(`item 1 names no environment the project rules allow (${allowed.join(', ')})`);
    }
    let foreign = 0;
    let links = 0;
    if (hosts.size) {
      const named = [...hosts].filter((h) => lines.some((l, i) => itemAt[i] === 1 && hostIn(l, h)));
      if (!named.length) fails.push('item 1 names no store host the project rules list');
      const crossed = new Set();
      lines.forEach((l, i) => {
        foreign += [...l.matchAll(MYSHOPIFY)].filter((m) => !hosts.has(m[0].toLowerCase())).length;
        for (const m of l.matchAll(PAGE_URL)) {
          if (!hosts.has(m[1].toLowerCase()) && !/\.myshopify\.com$/i.test(m[1]) && CATALOG_PATH.test(m[2])) foreign += 1;
          if (!pageLink(i, m[1], m[2])) continue;
          links += 1;
          if (named.length && !named.includes(m[1].toLowerCase())) crossed.add(m[1].toLowerCase());
        }
      });
      if (foreign) fails.push(`storefront host the project rules do not list (${[...hosts].join(', ')})`);
      if (crossed.size) fails.push(`page link on a store item 1 does not name (${[...crossed].join(', ')})`);
      if (linking && lines.some((l) => [...l.matchAll(CODE_SPAN)].some((m) => storeLink(m[2])) || [...l.matchAll(MD_LINK)].some((m) => storeLink(m[1]))))
        fails.push('page link not bare (a code span or [label](url) is not clickable in Jira)');
    }
    if (rules.theme === 'published' && PREVIEW_ID.test(text)) fails.push('preview link with theme: published (the published theme opens with the plain storefront URL)');
    if (rules.links === 'required' && !links && !noPageLink) fails.push('no page link on a project store in items 2–3 (links: required; a change with no storefront page: --no-page-link with the receipt\'s page_links: none — <why>)');
    ruled.push('rules=on', `page_links=${links}`, `foreign_hosts=${foreign}`, ...(noPageLink ? ['no_page_link=on'] : []));
  }
  const words = wordCount(lines);
  const hits = attributionHits(text);
  if (hits) fails.push('AI attribution');
  const warn = words > STT_MAX_WORDS ? ['warn=over-160'] : words > STT_TARGET_WORDS ? ['warn=over-120-target'] : [];
  return report(['kind=stt', `items=${nums.length}`, `words=${words}`, ex, ...ruled, `attribution_hits=${hits}`, ...warn], fails);
}

// fe create-pull-request reference/body-sections.md: the core skeleton, in order. The docs ask for a
// `## <Name>` heading line; a bold label at the start of a line is accepted too.
const CORE = [
  ['Summary', /^summary\b/i],
  ['Jira ticket', /^jira\b/i],
  ['To check', /^to check\b/i],
  ['Screenshots', /^screenshots?\b/i],
  ['Changes', /^changes\b/i],
];
const sectionLabel = (line) => {
  const m = /^(?:#{1,6}[ \t]+|\*\*)(.+)$/.exec(line.trim());
  return m ? m[1].replace(/\*\*/g, '').trim() : null;
};

function summarySentences(lines, from, to) {
  const body = lines.slice(from, to).map((l, i) => {
    let s = l.replace(/^\s*>\s?/, '');
    if (i === 0) s = s.replace(/^(?:#{1,6}[ \t]+|\*\*)?summary\b(?:\*\*)?[\s:—–-]*(?:\*\*)?\s*/i, '');
    return s.trim();
  }).filter(Boolean).join(' ');
  return body.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => /\w/.test(s));
}

/** `--no-preview` state: 'off' without the flag; 'recorded' when <dir of path>/notes.md holds a `preview-decision: no preview` line, else 'unrecorded'. */
function noPreviewState(path, flag) {
  if (!flag) return 'off';
  let notes = '';
  try { notes = fs.readFileSync(nodePath.join(nodePath.dirname(path), 'notes.md'), 'utf8'); } catch (e) { return 'unrecorded'; }
  return /preview-decision:\s*no preview/i.test(notes) ? 'recorded' : 'unrecorded';
}

/** PR body: core skeleton in order, the theme table unless `noPreview` is 'recorded', no None/N/A section, Summary sentence lengths, attribution. */
function checkPr(path, noPreview) {
  const fails = [];
  const text = readFile(path, fails);
  const np = `no_preview=${noPreview}`;
  if (text === null) return report(['kind=pr', np], fails);
  const lines = text.split('\n');
  const at = CORE.map(([, re]) => lines.findIndex((l) => { const s = sectionLabel(l); return s !== null && re.test(s); }));
  CORE.forEach(([name], i) => { if (at[i] < 0) fails.push(`section missing: ${name} (a \`## ${name}\` heading line)`); });
  const found = at.filter((i) => i >= 0);
  if (found.some((v, i) => i && v < found[i - 1])) fails.push('core sections out of order');
  if (noPreview !== 'recorded') {
    const row = lines.findIndex((l) => /^\s*\|\s*\*\*(Preview|Theme ID|Theme name)\*\*\s*\|/.test(l));
    if (row < 0) fails.push(noPreview === 'unrecorded'
      ? `theme preview table missing (--no-preview needs a 'preview-decision: no preview' line in ${nodePath.join(nodePath.dirname(path), 'notes.md')})`
      : "theme preview table missing (pass --no-preview only with the developer's explicit no-preview answer)");
    else if ((at[1] >= 0 && row < at[1]) || (at[2] >= 0 && row > at[2])) fails.push('theme preview table not between Jira ticket and To check');
  }
  if (lines.some((l) => /^\s*(?:[-*>]\s*)?[_*]*\(?(none|n\/a)\)?\.?[_*]*\s*$/i.test(l))) fails.push('None/N/A placeholder');
  let sentences = [];
  if (at[0] >= 0) {
    const next = at.filter((i) => i > at[0]);
    sentences = summarySentences(lines, at[0], next.length ? Math.min(...next) : lines.length);
    if (!sentences.length) fails.push('Summary empty');
  }
  const long = sentences.filter((s) => s.split(/\s+/).filter(Boolean).length >= 20).length;
  if (long) fails.push('Summary sentence of 20 words or more');
  const hits = attributionHits(text);
  if (hits) fails.push('AI attribution');
  return report(['kind=pr', np, `summary_sentences=${sentences.length}`, `long_sentences=${long}`, `attribution_hits=${hits}`], fails);
}

// fe create-pull-request Phase 2 step 2: the PR line, then an optional brief of at most 6 lines.
// A preview theme is deleted after merge, so its link, id or editor URL rots in the ticket.
const PR_LINE = /^PR: https:\/\/\S+\/pull\/\d+ — \S/;
const ROT = [
  ['preview theme link', /preview_theme_id=|shopifypreview\.com|\/themes\/\d+\/preview/i],
  ['editor URL', /\/themes\/\d+\/editor|\/admin\/themes\/\d+|admin\.shopify\.com\/store\/[^/\s]+\/themes\/\d+/i],
  ['theme id', /\btheme[ _-]?id\b|\btheme\s*#?\d{6,}|\b\d{11,14}\b/i],
];
// a GFM table as base scripts/md-to-adf.cjs reads one: a row with an unescaped pipe over a separator
// row, then every following non-blank row with a pipe; a line that only holds a pipe is no table
const PIPE = /(?<!\\)\|/;
const TABLE_SEP = /^[ \t]*\|?[ \t:]*-{1,}[-\t :|]*$/;
/** The indexes of `raw`'s table rows and the number of tables. */
function tableRows(raw) {
  const rows = new Set();
  let n = 0;
  for (let i = 0; i + 1 < raw.length; i++) {
    if (rows.has(i) || !PIPE.test(raw[i]) || !PIPE.test(raw[i + 1]) || !TABLE_SEP.test(raw[i + 1])) continue;
    n += 1;
    rows.add(i).add(i + 1);
    for (let j = i + 2; j < raw.length && PIPE.test(raw[j]) && raw[j].trim(); j++) rows.add(j);
  }
  return { rows, n };
}
const BRIEF_KEY = /^\s*(?:workspace|mode|answers|ticket|target|findings|related|screenshot_dir|previous|feedback|question|pr_url|pr_title|brief|table):\s|^\s*(?:branch|base)=/;

/** Jira PR-link comment: the PR line first, brief lines ≤ 6, no bare label, no None/N/A, nothing that rots, no brief text, attribution; a table only with `table` (the developer's request), its rows outside the brief. */
function checkJira(path, table) {
  const fails = [];
  const text = readFile(path, fails);
  if (text === null) return report(['kind=jira'], fails);
  const raw = text.split('\n');
  const tables = tableRows(raw);
  if (tables.n && !table) fails.push("table in the comment (only on the developer's request: --table, and base:jira-writer with tables: keep)");
  const lines = raw.filter((l) => l.trim());
  if (!PR_LINE.test(lines[0] || '')) fails.push("line 1 is not 'PR: <url> — <title>'");
  const brief = raw.filter((l, i) => l.trim() && !tables.rows.has(i)).slice(1);
  if (brief.length > 6) fails.push('brief longer than 6 lines');
  if (brief.some((l) => !/^\s*[-*]\s+\S/.test(l))) fails.push('brief line is not a bullet');
  if (lines.some((l) => /^#{1,6} /.test(l))) fails.push('heading in the comment');
  // a bullet that is one bold span of four or more words not ending in a colon, or ending in a CJK
  // stop, is a sentence — content, never a label (a label is 1–3 words: `**Note:**`, `**Desktop**`)
  const sentence = (l) => /^\s*(?:[-*]\s+)?\*\*(?:(?=\s*[^\s*]+(?:\s+[^\s*]+){3})[^*]*[^\s*:]|[^*]*[。！？][)\]"'”’]*)\s*\*\*\s*$/.test(l);
  const label = (l) => !sentence(l) && /^\s*(?:[-*]\s+)?(?:\*\*[^*]+\*\*|[A-Z][\w /]*:)\s*(?:\*\*)?\s*:?\s*$/.test(l);
  const opensLabel = (l) => !sentence(l) && (label(l) || /^\s*(?:(?:[-*]\s+)?\*\*[^*]+\*\*|[A-Z][\w /]*:)/.test(l));
  // a next line that opens no bold label is its content (`- Desktop: …` too)
  if (brief.some((l, i) => label(l) && (i + 1 >= brief.length || opensLabel(brief[i + 1])))) fails.push('label with no content');
  if (lines.some((l) => /^\s*(?:[-*>]\s*)?(?:(?:\*\*[^*]+\*\*|[A-Z][\w /]*:)\s*:?\s*)?[_*]*\(?(none|n\/a)\)?\.?[_*]*\s*$/i.test(l))) fails.push('None/N/A placeholder');
  for (const [name, re] of ROT) if (lines.some((l) => re.test(l))) fails.push(name);
  if (lines.some((l) => BRIEF_KEY.test(l))) fails.push('brief text in the comment');
  const hits = attributionHits(text);
  if (hits) fails.push('AI attribution');
  return report(['kind=jira', `brief_lines=${brief.length}`, `tables=${tables.n}`, `attribution_hits=${hits}`], fails);
}

// `[a, b, "c, d"]` → its entries, commas inside quotes kept
function splitOptions(v) {
  const m = /^\[(.*)\]$/.exec(v.trim());
  if (!m) return null;
  const out = []; let cur = ''; let q = null;
  for (const ch of m[1]) {
    if (q) { if (ch === q) q = null; cur += ch; continue; }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (ch === ',') { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur.trim());
  return out.filter((s) => s.replace(/^["']|["']$/g, '').trim());
}

// `- a: x` opens an item; indented `b: y` lines add to it; indented `- v` lines under an empty `b:`
// make it a block list
function items(lines, opener) {
  const list = [];
  let last = null;
  for (const l of lines) {
    const open = new RegExp(`^\\s*-\\s+${opener}:\\s*(.*)$`).exec(l);
    if (open) { list.push({ [opener]: open[1].trim() }); last = opener; continue; }
    const it = list[list.length - 1];
    const f = /^\s+([a-z_]+):\s*(.*)$/.exec(l);
    if (f && it && !(f[1] in it)) { it[f[1]] = f[2].trim(); last = f[1]; continue; }
    const entry = /^\s+-\s+(.*\S)\s*$/.exec(l);
    if (entry && it && last && (it[last] === '' || Array.isArray(it[last]))) it[last] = [...(it[last] || []), entry[1]];
  }
  return list;
}

// a `key:` value, inline or the lines under it up to the next top-level `key:` line
function field(lines, key) {
  const i = lines.findIndex((l) => new RegExp(`^${key}:`).test(l));
  if (i < 0) return null;
  let v = lines[i].slice(key.length + 1).trim();
  if (v === '|' || v === '>' || v === '') {
    const block = [];
    for (const l of lines.slice(i + 1)) { if (/^[a-z_]+:/.test(l)) break; if (l.trim()) block.push(l.trim()); }
    v = block.join(' ');
  }
  return v;
}

/** A drafter's reply: exactly one kind, every field the contract names non-empty. */
function checkReceipt(kind, text) {
  const fails = [];
  const lines = text.split('\n');
  if (lines.some((l) => /^LOOKUP\s*$/.test(l))) return report(['kind=lookup'], ['LOOKUP is not a receipt kind any more']);
  const kinds = [];
  if (lines.some((l) => /^ESCALATE\s*$/.test(l))) kinds.push('escalate');
  for (const k of ['answer', 'written', 'error']) if (lines.some((l) => new RegExp(`^${k}:`).test(l))) kinds.push(k);
  if (kinds.length !== 1) {
    fails.push(kinds.length ? `several kinds in one reply (${kinds.join(', ')})` : 'no kind (ESCALATE, answer:, written:, error:)');
    return report([`kind=${kinds.join('+') || 'none'}`], fails);
  }
  const k = kinds[0];
  const out = [`kind=${k}`];
  if (k === 'escalate') {
    const list = items(lines, 'question');
    out.push(`items=${list.length}`);
    if (!list.length) fails.push('ESCALATE with no question');
    if (list.length > 4) fails.push('more than 4 questions');
    list.forEach((it, i) => {
      for (const f of ['question', 'context', 'options']) if (!it[f]) fails.push(`item ${i + 1} ${f} empty`);
      if (it.options) { const o = Array.isArray(it.options) ? it.options : splitOptions(it.options); if (!o || o.length < 2) fails.push(`item ${i + 1} options fewer than 2`); }
    });
  } else if (k === 'written') {
    const p = field(lines, 'written') || '';
    const want = { stt: '/steps-to-test.md', pr: '/pr-body.md', jira: '/jira-comment.md' }[kind];
    if (!p.startsWith('/') || !p.endsWith(want)) fails.push(`written is not an absolute path ending in ${want}`);
    if (field(lines, 'unconfirmed') === null) fails.push('unconfirmed missing');
    if (!field(lines, 'report')) fails.push('report empty');
    if (kind === 'stt') {
      const proposal = field(lines, 'ac_proposal');
      if (field(lines, 'ac') === 'empty') { if (!proposal) fails.push('ac_proposal empty with ac: empty'); }
      else if (proposal !== null) fails.push('ac_proposal without ac: empty');
      const waiver = field(lines, 'page_links');
      const needed = field(lines, 'pages_needed');
      if (waiver !== null && !/^none\s*[—–-]+\s*\S/.test(waiver)) fails.push("page_links is not 'none — <why>'");
      if (needed !== null && !needed) fails.push('pages_needed empty');
      if (waiver !== null && needed !== null) fails.push('pages_needed with page_links: none');
    }
    if (kind === 'pr') {
      if (!field(lines, 'title')) fails.push('title empty');
      if (!field(lines, 'pr_summary')) fails.push('pr_summary empty');
      const shots = field(lines, 'screenshots');
      if (shots === null) fails.push('screenshots missing');
      else if (/^\[\s*\]$/.test(shots) && !field(lines, 'capture')) fails.push('capture empty with screenshots: []');
    }
  } else if (!field(lines, k)) {
    fails.push(`${k} empty`);
  }
  return report(out, fails);
}

function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) { process.stdout.write(USAGE + '\n'); return 0; }
  const [cmd, kind, path, ...rest] = argv;
  if (cmd === 'rules' && kind && !kind.startsWith('--') && (path === undefined || (path === '--prose' && !rest.length))) return checkRules(kind, path === '--prose');
  if (cmd === 'rules-path') {
    const args = argv.slice(1);
    if (!args.length) return rulesPath(process.cwd());
    if (args.length === 2 && args[0] === '--cwd' && args[1]) return rulesPath(nodePath.resolve(args[1]));
    process.stderr.write(USAGE + '\n');
    return 2;
  }
  if (!['stt', 'pr', 'jira'].includes(kind)) { process.stderr.write(USAGE + '\n'); return 2; }
  if (cmd === 'file' && path) {
    let refs = null;
    const r = rest.indexOf('--refs');
    if (kind === 'stt' && r >= 0) {
      refs = rest[r + 1];
      rest.splice(r, 2);
      try { if (!refs || !fs.statSync(refs).isDirectory()) refs = null; } catch (e) { refs = null; }
      if (!refs) { process.stderr.write(USAGE + '\n'); return 2; }
    }
    let rules = null;
    const p = rest.indexOf('--project-rules');
    if (kind === 'stt' && p >= 0) {
      rules = rest[p + 1];
      rest.splice(p, 2);
      if (!rules || rules.startsWith('--')) { process.stderr.write(USAGE + '\n'); return 2; }
    }
    const noPageLink = rest.includes('--no-page-link');
    const unknown = rest.filter((a) => !(kind === 'pr' && (a === '--theme' || a === '--no-preview')) && !(rules && a === '--no-page-link')
      && !(kind === 'jira' && a === '--table'));
    if (unknown.length) { process.stderr.write(USAGE + '\n'); return 2; }
    if (kind === 'jira') return checkJira(path, rest.includes('--table'));
    return kind === 'stt' ? checkStt(path, refs, rules, noPageLink) : checkPr(path, noPreviewState(path, rest.includes('--no-preview')));
  }
  if (cmd === 'receipt' && path === undefined) {
    let text = '';
    try { text = fs.readFileSync(0, 'utf8'); } catch (e) { /* no stdin → empty reply */ }
    return checkReceipt(kind, text);
  }
  process.stderr.write(USAGE + '\n');
  return 2;
}

process.exitCode = main(process.argv.slice(2));
