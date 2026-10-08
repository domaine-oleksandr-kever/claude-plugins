#!/usr/bin/env node
// Suite for plugins/slim/scripts/slim.cjs — slim's Claude Code delivery — run end to end on the real
// fixtures in tests/fixtures/ and on synthetic inputs built inline: decisions, restored result shapes,
// records and the report, per channel. Every case spawns the core in its own temp dir with an explicit
// env, so a developer's exported SLIM_* never reaches it and no row writes to the real report log. The engines themselves are tested as pure functions in tests/slim-engines.mjs.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import {
  readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, existsSync, readdirSync, realpathSync,
  utimesSync, copyFileSync, unlinkSync, symlinkSync, statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const SCRIPTS = path.join(ROOT, 'plugins/slim/scripts');
const SLIM = path.join(SCRIPTS, 'slim.cjs');
const FND_SCRIPTS = path.join(ROOT, 'plugins/fnd/scripts');
// fnd's frozen json-slim: the compressor slim's json engine was ported from.
const FROZEN_JSON = path.join(FND_SCRIPTS, 'json-slim.cjs');
const FND_HOOK = path.join(ROOT, 'plugins/fnd/hooks/mcp-slim.cjs');
const MODS = path.join(ROOT, 'plugins/slim/hooks/mods');
const BOUND = 32768 + 1200;
const FIX = path.join(ROOT, 'tests/fixtures');
const LOG = 'fnd-mcp-slim-debug.log';

// The envelope the hooks module sends, keys in its order (agentId, pre, bytes_in only when set).
const ENVELOPE_KEYS = ['v', 'channel', 'tool', 'tool_use_id', 'tool_input', 'tool_response', 'is_error', 'cwd', 'session_id', 'agentId', 'pre', 'bytes_in'];
const M1_KEYS = ENVELOPE_KEYS.slice(0, 9);
const CHANNELS = ['mcp', 'bash', 'read', 'webfetch', 'websearch', 'grep', 'glob', 'agent', 'attachment', 'prompt', 'lookup', 'view'];
const ENGINES = ['json', 'jsonl', 'log', 'html', 'figma', 'figma-nodes', 'adf', 'text', 'stub'];

const F1 = readFileSync(path.join(FIX, 'jql-search-ELC.json'), 'utf8');
const F2 = JSON.parse(readFileSync(path.join(FIX, 'mcp-envelope-jira.json'), 'utf8'));
const F3 = readFileSync(path.join(FIX, 'figma-design-context.jsx'), 'utf8');
const F4 = readFileSync(path.join(FIX, 'jira-issue-ELC-104.json'), 'utf8');
const F5 = readFileSync(path.join(FIX, 'figma-metadata-3326-39542.xml'), 'utf8');
const REST = readFileSync(path.join(FIX, 'figma-node-rest.json'), 'utf8');
// Three re-id'd copies of the fixture's frame: its node tree (~90 KB) is over every egress cap.
const REST_BIG = (() => {
  const v = JSON.parse(REST);
  const doc = Object.values(v.nodes)[0].document;
  const reid = (n, k) => ({ ...n, id: `${n.id}~${k}`, children: (n.children || []).map((c) => reid(c, k)) });
  doc.children = [0, 1, 2].flatMap((k) => doc.children.map((c) => reid(c, k)));
  return JSON.stringify(v);
})();

let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) pass++;
  else { fail++; failures.push(`[${name}] ${detail || ''}`); }
}
const eq = (name, actual, expected) => check(name, JSON.stringify(actual) === JSON.stringify(expected),
  `\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);

const TEMPS = [];
const LOG_DIRS = [];
function newT() {
  const T = realpathSync(mkdtempSync(path.join(tmpdir(), 'slimfx-')));
  TEMPS.push(T);
  return T;
}

function envFor(T, extra = {}) {
  const env = {
    PATH: process.env.PATH, HOME: `${T}/home`, XDG_CONFIG_HOME: `${T}/xdg`, CLAUDE_CONFIG_DIR: `${T}/cfg`,
    SLIM_DIR: `${T}/spill`, SLIM_DEBUG: '2', ...extra,
  };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  return env;
}

function envelope(T, response, extra = {}) {
  const all = {
    v: 1, channel: 'mcp', tool: 'mcp__x__y', tool_use_id: 'toolu_fx', tool_input: {}, tool_response: response,
    is_error: false, cwd: T, session_id: 's1', ...extra,
  };
  const out = {};
  for (const k of ENVELOPE_KEYS) if (all[k] !== undefined) out[k] = all[k];
  return out;
}

// The hooks module's parseOut rules, restated: what the core prints must survive them.
function contractProblem(a) {
  if (!a || typeof a !== 'object' || Array.isArray(a) || typeof a.decision !== 'string') return 'decision is not a string';
  const r = a.record;
  if (!r || typeof r.bytes_in !== 'number' || typeof r.bytes_out !== 'number' || typeof r.ms !== 'number') return 'record bytes_in/bytes_out/ms not numeric';
  if (a.decision === 'compressed' || a.decision === 'stubbed') {
    if (!('result' in a)) return 'no result';
    if (!ENGINES.includes(r.engine)) return `engine ${r.engine}`;
  } else if (r.engine !== null) return `engine ${r.engine} on ${a.decision}`;
  return null;
}

function spawn(T, input, { extra = {}, args = [], script = SLIM, cwd = T } = {}) {
  const env = envFor(T, extra);
  if (env.SLIM_DIR) LOG_DIRS.push(env.SLIM_DIR);
  if (env.FND_MCP_SLIM_DIR) LOG_DIRS.push(env.FND_MCP_SLIM_DIR);
  return spawnSync('node', [script, ...args], { cwd, env, input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

// fnd's classic PostToolUse hook on one result → its updatedToolOutput, or null when it passed through.
function fndSlim(T, response, extra = {}, args = []) {
  const env = envFor(T, { SLIM_DIR: undefined, SLIM_DEBUG: undefined, FND_MCP_SLIM_DIR: `${T}/fspill`, ...extra });
  const input = JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'mcp__x__y', tool_input: {}, tool_response: response, cwd: T, session_id: 's1' });
  const r = spawnSync('node', [FND_HOOK, ...args], { cwd: T, env, input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  try { return JSON.parse(r.stdout).hookSpecificOutput.updatedToolOutput; } catch (_) { return null; }
}

// One tool result through the core → its parsed answer (null when stdout is not JSON).
function call(name, T, env, extra) {
  const r = spawn(T, JSON.stringify(env), { extra });
  check(`${name}-exit`, r.status === 0, `exit ${r.status} stderr=${r.stderr}`);
  let a = null;
  try { a = JSON.parse(r.stdout); } catch (_) {}
  const problem = contractProblem(a);
  check(`${name}-contract`, problem === null, `${problem}: ${String(r.stdout).slice(0, 300)}`);
  return a || { record: {} };
}

function logLines(dir) {
  const f = path.join(dir, LOG);
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
const textOf = (v) => (typeof v === 'string' ? v : JSON.stringify(v));
const handleOf = (s) => { const m = /<<full=(\S+) original_result>>$/.exec(s); return m ? m[1] : null; };
const mcpSpills = (dir) => (existsSync(dir) ? readdirSync(dir).filter((n) => /^fnd-mcp-slim-[0-9a-f]{16}(-[0-9a-f]+)?\.json$/.test(n)) : []);
const FIGURE_OUT = /^(?:fnd-mcp-slim|slim): (?:compressed|stub) [\d,]+ B → ([\d,]+) B \(/m;
const figureOf = (t) => { const m = FIGURE_OUT.exec(t); return m ? Number(m[1].replace(/,/g, '')) : null; };
const bytes = (s) => Buffer.byteLength(s, 'utf8');
const old = (p) => { const t = new Date(Date.now() - 48 * 3600 * 1000); utimesSync(p, t, t); };

let F1_OUT = null;
{
  const T = newT();
  const a = call('F1', T, envelope(T, F1));
  eq('F1-decision', [a.decision, a.reason, a.record.engine], ['compressed', null, 'json']);
  const res = typeof a.result === 'string' ? a.result : '';
  check('F1-handle', /\n\n<<full=.*\/spill\/fnd-mcp-slim-[0-9a-f]{16}(-[0-9a-f]+)?\.json original_result>>$/.test(res), res.slice(-200));
  const h = handleOf(res);
  check('F1-spill-is-original', !!h && existsSync(h) && readFileSync(h, 'utf8') === F1, `spill ${h}`);
  check('F1-figure-shape', /^slim: compressed 110,794 B → [\d,]+ B \(−\d+\.\d%\)$/.test(a.figure || ''), a.figure);
  check('F1-figure-in-body', !!a.figure && res.includes(`\n\n${a.figure}\n\n`), 'figure not verbatim in the result');
  eq('F1-figure-is-size', figureOf(a.figure || ''), bytes(res));
  check('F1-under-30k', a.record.bytes_out < 30000 && a.record.bytes_out === bytes(res), `bytes_out ${a.record.bytes_out}`);
  check('F1-no-fnd-label', !res.includes('fnd-mcp-slim:') && !JSON.stringify(a).includes('fnd mcp-slim'), 'fnd label leaked');
  F1_OUT = res;
}
{
  const T = newT();
  const a = call('F2', T, envelope(T, F2));
  eq('F2-decision', [a.decision, a.record.engine], ['compressed', 'json']);
  check('F2-shape', Array.isArray(a.result) && a.result.length === F2.length, 'block array length changed');
}
{
  const T = newT();
  const a = call('F3', T, envelope(T, [{ type: 'text', text: F3 }]));
  eq('F3-decision', [a.decision, a.record.engine], ['compressed', 'figma']);
}
// A stub limit no row fit can meet still stubs; the default one is met by the trim and fit stages.
{
  const T = newT();
  const a = call('F4', T, envelope(T, F4), { SLIM_STUB_BYTES: '4000' });
  eq('F4-decision', [a.decision, a.reason, a.record.engine], ['stubbed', 'weak-gain', 'stub']);
  const res = typeof a.result === 'string' ? a.result : '';
  check('F4-stub-header', res.startsWith('<<slim stub>> mcp__x__y returned '), res.slice(0, 80));
  check('F4-recipe-view', res.includes('mcp__slim__view({ path: ') && res.includes('windowed (offset/limit)') && !res.includes('json-slim'), 'recipe does not name the view tool and a windowed Read');
  check('F4-figure', (a.figure || '').startsWith('slim: stub ') && res.includes(a.figure), a.figure);
  check('F4-no-fnd-marks', !res.includes('<<fnd-mcp-slim stub>>') && !/^fnd-mcp-slim:/m.test(res), 'fnd mark in a slim stub');
  const f = call('F4-fit', T, envelope(T, F4));
  eq('F4-fit-decision', [f.decision, f.reason, f.record.engine], ['compressed', null, 'json']);
  check('F4-fit-stages', ['trim', 'fit'].every((x) => (f.record.stages || []).includes(x)), JSON.stringify(f.record.stages));
}
// The Atlassian MCP's {issues:{nodes}} search: long markdown rows, no crush signal. Fitted under the stub limit, not stubbed.
{
  const T = newT();
  const JN = readFileSync(path.join(FIX, 'jql-nodes-ELC.json'), 'utf8');
  const tool = 'mcp__plugin_fnd_atlassian__searchJiraIssuesUsingJql';
  const a = call('JN', T, envelope(T, { content: [{ type: 'text', text: JN }] }, { tool }));
  eq('JN-decision', [a.decision, a.reason, a.record.engine], ['compressed', null, 'json']);
  const res = ((a.result || {}).content || [{}])[0].text || '';
  check('JN-not-stub', !res.includes('<<slim stub>>'), res.slice(0, 80));
  check('JN-stats-line', /^slim: compressed [\d,]+ B → [\d,]+ B \(−\d+\.\d%\)$/m.test(res) && res.includes(a.figure), a.figure);
  const h = handleOf(res);
  check('JN-handle', !!h && readFileSync(h, 'utf8') === JSON.stringify({ content: [{ type: 'text', text: JN }] }), `spill ${h}`);
  check('JN-stages', ['noise', 'trim', 'fit'].every((x) => (a.record.stages || []).includes(x)), JSON.stringify(a.record.stages));
  const body = res.slice(0, res.indexOf('\n\nslim: '));
  check('JN-under-limit', bytes(body) <= 32768, String(bytes(body)));
  const v = JSON.parse(body);
  const nodes = v.issues.nodes;
  const kept = nodes.filter((n) => n.key);
  const rowsCite = /<<full=(\S+) (\d+)_rows_offloaded>>/.exec(nodes[nodes.length - 1]._ccr_dropped || '');
  check('JN-rows-part', !!rowsCite && JSON.parse(readFileSync(rowsCite[1], 'utf8')).length === Number(rowsCite[2]) && kept.length + Number(rowsCite[2]) === 50, rowsCite && rowsCite[0]);
  eq('JN-ends-kept', [kept[0].key, kept[kept.length - 1].key], ['ELC-1401', 'ELC-1450']);
  const L = logLines(`${T}/spill`).filter((r) => r.tool === tool);
  check('JN-record-stages', L.length === 1 && L[0].stages.includes('trim') && L[0].decision === 'compressed', JSON.stringify(L.map((r) => [r.decision, r.stages])));
  // Two blocks share the limit: each is fitted to half, so their joined text is not stubbed either.
  const two = call('JN-two', T, envelope(T, { content: [{ type: 'text', text: JN }, { type: 'text', text: JN }] }, { tool }));
  const texts = ((two.result || {}).content || []).map((b) => b.text || '');
  check('JN-two-blocks', two.decision === 'compressed' && texts.length === 2 && bytes(texts[0]) <= 16384 && !texts.join('').includes('<<slim stub>>'), `${two.decision} ${texts.map(bytes)}`);
}
{
  const T = newT();
  const a = call('F5', T, envelope(T, [{ type: 'text', text: F5 }]));
  eq('F5-decision', [a.decision, a.reason, a.record.format], ['passthrough', 'non-json', 'xml']);
  check('F5-no-result', !('result' in a), 'a passthrough carries no result');
}
{
  const T = newT();
  const a = call('F6', T, envelope(T, F1, { tool: 'mcp__plugin_figma_figma__get_metadata' }));
  eq('F6-tool-name-ignored', [a.decision, a.record.engine], ['compressed', 'json']);
}

{
  const lines = [];
  for (let i = 0; i < 600; i++) {
    const lvl = i % 97 === 0 ? 'ERROR' : 'INFO';
    lines.push(`2026-10-07 10:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.123 ${lvl} [worker-${i % 7}] sync.Job - processed batch ${i} of the nightly catalogue import`);
  }
  const T = newT();
  const a = call('S1', T, envelope(T, lines.join('\n')));
  eq('S1-plain-log', [a.decision, a.record.engine], ['compressed', 'log']);
}
{
  const rows = [];
  for (let i = 0; i < 600; i++) rows.push(JSON.stringify({ id: i, sku: `SKU-${i % 40}`, status: i % 50 ? 'ok' : 'error', qty: i % 9, price: 19.99 }));
  const T = newT();
  const a = call('S2', T, envelope(T, rows.join('\n')));
  eq('S2-jsonl', [a.decision, a.record.engine, a.record.stages], ['compressed', 'jsonl', ['jsonl', 'crush']]);
}
{
  const T = newT();
  const a = call('S3', T, envelope(T, '{"issues":[]}'));
  eq('S3-size-gate', [a.decision, a.reason], ['passthrough', 'size-gate']);
  eq('S3-line-at-2', logLines(`${T}/spill`).map((l) => l.reason), ['size-gate']);
  const T1 = newT();
  call('S3b', T1, envelope(T1, '{"issues":[]}'), { SLIM_DEBUG: '1' });
  eq('S3-no-line-at-1', logLines(`${T1}/spill`).length, 0);
}
{
  const T = newT();
  const a = call('S4', T, envelope(T, F1, { is_error: true }));
  eq('S4-is-error', [a.decision, a.reason], ['passthrough', 'error-shape']);
  const b = call('S5', T, envelope(T, { isError: true, content: [{ type: 'text', text: F1 }] }));
  eq('S5-error-envelope', [b.decision, b.reason], ['passthrough', 'error-shape']);
}
let STUB0_OUT = null;
{
  const rows = [];
  for (let i = 0; rows.join(',').length < 5000; i++) rows.push({ id: i, key: `ELC-${i}`, summary: 'a short summary line' });
  const shapes = {
    a: `${JSON.stringify({ rows })}\n\nfnd-mcp-slim: compressed 110,794 B → 22,179 B (−80.0%)\n\n<<full=/tmp/fnd-mcp-slim-0123456789abcdef.json original_result>>`,
    b: F1_OUT,
    c: `<<fnd-mcp-slim stub>> mcp__x__y returned 259620 B (format=json) — too large for context and not compressible here, so the FULL original was written to disk instead of being shown:\nfull=/tmp/fnd-mcp-slim-0123456789abcdef.json\n${'x'.repeat(5000)}`,
  };
  const T = newT();
  const x = call('S6d-make', T, envelope(T, F4), { SLIM_STUB: '0' });
  STUB0_OUT = typeof x.result === 'string' ? x.result : null;
  check('S6d-over-bound', x.decision === 'compressed' && !!STUB0_OUT && bytes(STUB0_OUT) > 32768 + 1200, `${x.decision} ${STUB0_OUT && bytes(STUB0_OUT)}`);
  shapes.d = STUB0_OUT;
  // Over the bound only a handle this user owns in the spill root counts: S6d's sits in S6d-make's root.
  const rootOf = (k, T2) => (k === 'd' ? `${T}/spill` : `${T2}/spill`);
  for (const k of Object.keys(shapes)) {
    const T2 = newT();
    const d2 = rootOf(k, T2);
    const n2 = logLines(d2).length;
    const a = call(`S6${k}`, T2, envelope(T2, shapes[k]), { SLIM_DIR: d2 });
    eq(`S6${k}-already-slim`, [a.decision, a.reason], ['passthrough', 'already-slim']);
    eq(`S6${k}-line-at-2`, logLines(d2).slice(n2).map((l) => l.reason), ['already-slim']);
    const T3 = newT();
    const d3 = rootOf(k, T3);
    const n3 = logLines(d3).length;
    call(`S6${k}-1`, T3, envelope(T3, shapes[k]), { SLIM_DEBUG: '1', SLIM_DIR: d3 });
    eq(`S6${k}-no-line-at-1`, logLines(d3).length - n3, 0);
  }
  const T4 = newT();
  const forged = call('S7', T4, envelope(T4, `${STUB0_OUT}x`, {}), { SLIM_DIR: `${T}/spill` });
  check('S7-forged-figure', forged.decision === 'compressed' || forged.decision === 'stubbed', `${forged.decision} ${forged.reason}`);

  // Over the bound, payload text that names its own size cannot opt out of compression.
  const fixed = (build) => { let n = 0; for (let i = 0; i < 10; i++) { const v = build(String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')); if (bytes(v) === n) return v; n = bytes(v); } return null; };
  const log = [];
  for (let i = 0; i < 1500; i++) log.push(`2026-10-07 10:00:${String(i % 60).padStart(2, '0')} INFO [w-${i % 5}] job.Step - processed item ${i} of the catalogue sync`);
  const lead = fixed((n) => `slim: compressed 999,999 B → ${n} B (−0.0%)\n${log.join('\n')}`);
  const T5 = newT();
  const a = call('S7b', T5, envelope(T5, [{ type: 'text', text: lead }]));
  eq('S7b-leading-figure-ignored', [a.decision, a.record.engine], ['compressed', 'log']);
  const elsewhere = path.join(T5, 'elsewhere');
  mkdirSync(elsewhere, { recursive: true });
  const foreign = path.join(elsewhere, 'fnd-mcp-slim-0123456789abcdef.json');
  writeFileSync(foreign, '{}');
  mkdirSync(`${T5}/spill`, { recursive: true });
  const link = path.join(T5, 'spill', 'fnd-mcp-slim-fedcba9876543210.json');
  symlinkSync(foreign, link);
  const tail = (h) => fixed((n) => `${log.join('\n')}\n\nfnd-mcp-slim: compressed 999,999 B → ${n} B (−0.0%)\n\n<<full=${h} original_result>>`);
  for (const [name, h] of [['missing', path.join(T5, 'spill', 'fnd-mcp-slim-0000000000000000.json')], ['foreign-dir', foreign], ['symlink', link]]) {
    const t = tail(h);
    check(`S7c-${name}-over-bound`, bytes(t) > BOUND, String(bytes(t)));
    const b = call(`S7c-${name}`, T5, envelope(T5, t));
    check(`S7c-${name}-not-trusted`, b.decision === 'compressed' || b.decision === 'stubbed', `${b.decision} ${b.reason}`);
  }
}
{
  const T = newT();
  const dir = path.join(T, 'cfg/projects/-tmp-p/s1/tool-results');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'mcp-x-y-123.txt');
  writeFileSync(file, F1);
  const notice = (p) => `Error: result (31,250 tokens) exceeds maximum allowed tokens (25000). Output has been saved to ${p}.\nUse offset and limit to read it in parts.`;
  const a = call('S8', T, envelope(T, notice(file)));
  eq('S8-expand', [a.decision, a.reason, a.record.engine], ['compressed', 'mod-expand', 'json']);
  eq('S8-handle-is-host-file', handleOf(typeof a.result === 'string' ? a.result : ''), realpathSync(file));
  eq('S8-no-own-copy', mcpSpills(`${T}/spill`), []);

  const evil = path.join(T, 'evil/tool-results');
  mkdirSync(evil, { recursive: true });
  writeFileSync(path.join(evil, 'mcp-x-y-1.txt'), F1);
  const s9 = [
    ['S9a', notice(path.join(evil, 'mcp-x-y-1.txt')), 's1', 'expand-refused'],
    ['S9b', notice(file), 's2', 'expand-refused'],
    ['S9c', notice(file), '../s1', 'expand-refused'],
    ['S9d', notice(path.join(dir, 'mcp-x-y-999.txt')), 's1', 'expand-missing'],
  ];
  for (const [name, text, sid, why] of s9) {
    const r = call(name, T, envelope(T, text, { session_id: sid }));
    eq(`${name}-${why}`, [r.decision, r.reason], ['passthrough', why]);
  }
  const e = call('S8e', T, envelope(T, notice(file), { is_error: true }));
  eq('S8e-error-notice', [e.decision, e.reason], ['passthrough', 'error-shape']);

  // A small slimmed result that quotes the phrase above its own host-file handle is no fresh notice,
  // whichever plugin slimmed it.
  const issues = [];
  for (let i = 0; i < 80; i++) {
    const summary = `${i === 79 ? 'MCP result exceeds maximum allowed tokens on search ' : ''}Fix ${['header', 'footer', 'cart', 'PDP', 'search', 'menu', 'filter'][i % 7]} spacing on ${['iPhone', 'Android', 'desktop'][i % 3]} build ${(i * 7919) % 1000}`;
    issues.push({ key: `ELC-${i}`, fields: { summary, status: { name: ['Open', 'Done', 'QA'][i % 3], id: String(i % 3) }, assignee: { displayName: `Dev ${i % 11}` }, updated: `2026-10-0${(i % 9) + 1}T10:00:00.000+0000` } });
  }
  const quoting = path.join(dir, 'mcp-x-y-456.txt');
  writeFileSync(quoting, JSON.stringify({ issues }));
  const own = call('S8f-make', T, envelope(T, notice(quoting)));
  const ownOut = typeof own.result === 'string' ? own.result : '';
  check('S8f-quotes-the-phrase', own.reason === 'mod-expand' && bytes(ownOut) <= 8192 && ownOut.includes('exceeds maximum allowed tokens'), `${own.decision} ${own.reason} ${bytes(ownOut)}`);
  const back = call('S8f-own', T, envelope(T, ownOut));
  eq('S8f-own-already-slim', [back.decision, back.reason], ['passthrough', 'already-slim']);
  // A 2,400 B bound puts the same output under the exact rule: its handle is this session's host spill.
  const exact = call('S8f-own-exact', T, envelope(T, ownOut), { SLIM_STUB_BYTES: '1200' });
  check('S8f-exact-over-bound', bytes(ownOut) > 2400, String(bytes(ownOut)));
  eq('S8f-own-exact-already-slim', [exact.decision, exact.reason], ['passthrough', 'already-slim']);
  const fnd = fndSlim(T, notice(quoting), {}, ['--from-mod', '--overflow=expand']);
  check('S8f-fnd-made', typeof fnd === 'string' && /^fnd-mcp-slim: compressed /m.test(fnd) && fnd.includes('exceeds maximum allowed tokens'), String(fnd).slice(0, 120));
  const fb = call('S8f-fnd', T, envelope(T, fnd));
  eq('S8f-fnd-already-slim', [fb.decision, fb.reason], ['passthrough', 'already-slim']);
}
// The stub's recovery recipe: the view tool and a windowed Read, never a CLI; the cap holds with a long path.
{
  const require = createRequire(import.meta.url);
  const emit = require(path.join(SCRIPTS, 'delivery/emit.cjs'));
  const { GRAMMAR } = require(path.join(SCRIPTS, 'engines/jq.cjs'));
  const file = `/${'d'.repeat(180)}/fnd-mcp-slim-0123456789abcdef.json`;
  const stats = 'slim: stub 250,000 B → 1,100 B (−99.6%)';
  const noGain = emit.stubText('mcp__x__y', 250000, 'json', '{"a":1}', file, 'no-gain', false, stats);
  check('Rs-no-gain-jq', noGain.includes(`mcp__slim__view({ path: ${JSON.stringify(file)}, jq: "<jq-path>" })`) && noGain.includes(GRAMMAR), noGain);
  check('Rs-no-gain-windowed', noGain.includes('Read it windowed (offset/limit)'), noGain);
  const general = emit.stubText('mcp__x__y', 250000, 'text', 'hello', file, 'weak-gain', false, stats);
  check('Rs-general-view', general.includes(`mcp__slim__view({ path: ${JSON.stringify(file)} })`) && general.includes('Read it windowed (offset/limit)'), general);
  for (const [k, t] of [['no-gain', noGain], ['general', general]]) {
    check(`Rs-${k}-no-cli`, !/json-slim|\bnode /.test(t), t);
    check(`Rs-${k}-cap`, bytes(t) <= emit.STUB_CAP, String(bytes(t)));
  }
}
// fnd's real hook beneath, spilling into slim's spill root: whatever it emits, at either stub setting,
// slim must stand down on.
{
  const T = newT();
  for (const stub of ['1', '0']) {
    for (const [name, response] of [['F1', F1], ['F4', F4], ['F4-blocks', [{ type: 'text', text: F4 }]]]) {
      const out = fndSlim(T, response, { FND_MCP_SLIM_STUB: stub });
      const tag = `X-${name}-stub${stub}`;
      check(`${tag}-fnd-emitted`, out !== null, 'fnd emitted nothing');
      if (out === null) continue;
      if (stub === '0' && name === 'F4') check(`${tag}-over-bound`, bytes(out) > BOUND, String(bytes(out)));
      const a = call(tag, T, envelope(T, out), { SLIM_DIR: `${T}/fspill` });
      eq(`${tag}-already-slim`, [a.decision, a.reason], ['passthrough', 'already-slim']);
    }
  }
}
{
  const T = newT();
  const r = spawn(T, '{not json');
  let a = null;
  try { a = JSON.parse(r.stdout); } catch (_) {}
  check('S10-exit-0', r.status === 0, `exit ${r.status}`);
  eq('S10-error-answer', a && [a.decision, a.reason], ['error', 'SyntaxError']);
  const lines = logLines(`${T}/spill`);
  eq('S10-one-line', lines.map((l) => [l.src, l.decision, l.reason]), [['slim', 'error', 'SyntaxError']]);
  check('S10-no-payload', lines.length === 1 && !String(lines[0].error).includes('not json'), JSON.stringify(lines[0]));

  // The error line goes out at every level, so a link planted at the log's name is never followed.
  const T2 = newT();
  mkdirSync(`${T2}/spill`, { recursive: true });
  writeFileSync(`${T2}/target`, '');
  symlinkSync(`${T2}/target`, `${T2}/spill/${LOG}`);
  const l = spawn(T2, '{not json');
  check('S10-link-not-followed', l.status === 0 && statSync(`${T2}/target`).size === 0, `exit ${l.status}, target ${statSync(`${T2}/target`).size} B`);
}
{
  const T = newT();
  const r = spawn(T, JSON.stringify({ v: 1, channel: 'mcp', tool: 'mcp__x__y', tool_use_id: 'toolu_e', cwd: T, error: { name: 'spawn-rejected', message: 'spawn ENOENT' } }), { args: ['--error'] });
  check('S11-silent', r.status === 0 && r.stdout === '', `exit ${r.status} stdout=${r.stdout}`);
  const lines = logLines(`${T}/spill`);
  eq('S11-line', lines.map((l) => [l.src, l.channel, l.entry, l.decision, l.reason, l.error, l.tool_use_id]),
    [['slim', 'mcp', 'mod', 'error', 'spawn-rejected', 'spawn ENOENT', 'toolu_e']]);
}
{
  const T = newT();
  mkdirSync(path.join(T, 'p/scripts'), { recursive: true });
  mkdirSync(path.join(T, 'p/scripts/delivery'), { recursive: true });
  copyFileSync(path.join(SCRIPTS, 'slim.cjs'), path.join(T, 'p/scripts/slim.cjs'));
  for (const f of readdirSync(path.join(SCRIPTS, 'delivery'))) copyFileSync(path.join(SCRIPTS, 'delivery', f), path.join(T, 'p/scripts/delivery', f));
  const r = spawn(T, JSON.stringify(envelope(T, F1)), { script: path.join(T, 'p/scripts/slim.cjs') });
  let a = null;
  try { a = JSON.parse(r.stdout); } catch (_) {}
  check('S12-error', r.status === 0 && a && a.decision === 'error', `exit ${r.status} ${r.stdout.slice(0, 200)}`);
  eq('S12-line', logLines(`${T}/spill`).map((l) => [l.src, l.decision, l.entry]), [['slim', 'error', 'hook']]);
}
{
  const T = newT();
  call('S14-f1', T, envelope(T, F1));
  call('S14-f4', T, envelope(T, F4));
  const log = path.join(T, 'spill', LOG);
  writeFileSync(log, `${readFileSync(log, 'utf8')}${JSON.stringify({ ts: new Date().toISOString(), lvl: 2, entry: 'hook', tool: 't', decision: 'compressed', bytes_in: 1000, bytes_out: 400 })}\n`);
  const BY_SRC = /^ {2}by src: fnd 1000 → 400 B \(60\.0% saved\) · slim \d+ → \d+ B \([\d.]+% saved\)$/m;
  const r = spawn(T, '', { args: ['--report', log] });
  check('S14-report', r.status === 0 && r.stdout.includes('  totals:') && BY_SRC.test(r.stdout), r.stdout + r.stderr);
  const d = spawn(T, '', { args: ['--report'] });
  check('S14-default-file', d.status === 0 && BY_SRC.test(d.stdout) && d.stdout.includes(log), d.stdout + d.stderr);
  const m = spawn(T, '', { args: ['--report', path.join(T, 'nope.log')] });
  eq('S14-missing-file', m.status, 1);
  const s = spawn(T, '', { args: ['--report', log, '--since', 'not-a-date'] });
  eq('S14-bad-since', s.status, 1);
  const u = spawn(T, '', { args: ['--bogus'] });
  check('S14-unknown-flag', u.status === 2 && u.stdout === '' && u.stderr.includes('usage'), `exit ${u.status}`);
  const h = spawn(T, '', { args: ['--help'] });
  check('S14-help', h.status === 0 && h.stdout.trim().split('\n').length === 9 && ['--view', '--prompt', '--prompt-drop', '--access'].every((m) => h.stdout.includes(m)), h.stdout);
  check('S14-by-channel', /^ {2}by channel: mcp \d+ → \d+ B \([\d.]+% saved\)$/m.test(r.stdout), r.stdout);
  const rec = spawn(T, JSON.stringify({ tool_use_id: 'toolu_l', decision: 'answered', rung: 'url', engine: 'html', model: 'haiku', tokens: { input: 1200, output: 40 }, bytes_in: 60000, bytes_out: 300, ms: 900, cwd: T }), { args: ['--record'] });
  check('S14-record-silent', rec.status === 0 && rec.stdout === '', `exit ${rec.status}`);
  const l = spawn(T, '', { args: ['--report', log] });
  check('S14-lookup-line', /^ {2}lookup: 1 calls \(1 answered\) · 1200 in \/ 40 out tokens · haiku×1$/m.test(l.stdout), l.stdout);
  check('S14-lookup-not-in-totals', (/^ {2}by channel: (.*)$/m.exec(l.stdout) || [])[1] === (/^ {2}by channel: (.*)$/m.exec(r.stdout) || [])[1], 'a lookup line moved the byte totals');
}
{
  const T = newT();
  // fnd's switches never reach slim: with SLIM_DIR unset the spill root is the system temp dir.
  mkdirSync(`${T}/tmp`);
  const a = call('S15a', T, envelope(T, F1), { SLIM_DIR: undefined, TMPDIR: `${T}/tmp`, FND_MCP_SLIM_DIR: `${T}/fdir` });
  check('S15a-fnd-dir-ignored', (handleOf(a.result || '') || '').startsWith(`${T}/tmp/`) && logLines(`${T}/tmp`).length === 1 && !existsSync(`${T}/fdir`), handleOf(a.result || ''));
  const T2 = newT();
  const b = call('S15b', T2, envelope(T2, F1), { FND_MCP_SLIM_DIR: `${T2}/fdir` });
  check('S15b-own-dir', (handleOf(b.result || '') || '').startsWith(`${T2}/spill/`) && logLines(`${T2}/spill`).length === 1 && !existsSync(`${T2}/fdir`), handleOf(b.result || ''));
  const T3 = newT();
  call('S15c', T3, envelope(T3, [{ type: 'text', text: F5 }]), { SLIM_DEBUG: undefined, FND_MCP_SLIM_DEBUG: '1' });
  eq('S15c-fnd-debug-ignored', logLines(`${T3}/spill`), []);
  const T4 = newT();
  call('S15d', T4, envelope(T4, F1), { SLIM_DEBUG: '0', FND_MCP_SLIM_DEBUG: '2' });
  check('S15d-own-debug-only', !existsSync(path.join(T4, 'spill', LOG)), 'a log was written at SLIM_DEBUG=0');
  const T5 = newT();
  const e = call('S15e', T5, envelope(T5, F1), { FND_MCP_SLIM: '0' });
  eq('S15e-fnd-switch-ignored', e.decision, 'compressed');
}
{
  const T = newT();
  eq('S16-stub-off', call('S16a', T, envelope(T, F4), { SLIM_STUB: '0' }).decision, 'compressed');
  eq('S16-stub-bytes', call('S16b', T, envelope(T, F4), { SLIM_STUB_BYTES: '400000' }).decision, 'compressed');
  const b = call('S16c', T, envelope(T, F1), { SLIM_BUDGET_MS: '-1' });
  eq('S16-budget', [b.decision, b.reason], ['stubbed', 'budget-exceeded']);
}
{
  const seed = (T) => {
    mkdirSync(`${T}/spill`, { recursive: true });
    writeFileSync(`${T}/spill/fnd-crush-dead.json`, '[]');
    old(`${T}/spill/fnd-crush-dead.json`);
    writeFileSync(`${T}/spill/fnd-prompt-json-dead.json`, '[]');
    old(`${T}/spill/fnd-prompt-json-dead.json`);
    mkdirSync(`${T}/.claude/fnd-tmp/playwright`, { recursive: true });
    writeFileSync(`${T}/.claude/fnd-tmp/playwright/old.png`, 'png');
    old(`${T}/.claude/fnd-tmp/playwright/old.png`);
  };
  const T = newT();
  seed(T);
  call('S17', T, envelope(T, F1));
  check('S17-swept', !existsSync(`${T}/spill/fnd-crush-dead.json`) && existsSync(`${T}/spill/.slim-sweep`), 'stale spill kept or no marker');
  check('S17-fnd-marker-untouched', !existsSync(`${T}/spill/.fnd-mcp-slim-sweep`), 'slim wrote fnd\'s throttle marker');
  check('S17-fnd-only-kept', existsSync(`${T}/spill/fnd-prompt-json-dead.json`), 'slim swept a file only fnd writes');
  check('S17-no-project-pass', existsSync(`${T}/.claude/fnd-tmp/playwright/old.png`), 'the playwright dir was pruned');
  const T2 = newT();
  seed(T2);
  call('S17-ttl0', T2, envelope(T2, F1), { SLIM_TTL: '0' });
  check('S17-ttl0-kept', existsSync(`${T2}/spill/fnd-crush-dead.json`), 'SLIM_TTL=0 still swept');
  // fnd's TTL is not slim's: neither a longer one nor a 0 keeps a file past SLIM_TTL.
  const T3 = newT();
  seed(T3);
  call('S17-ttl-own', T3, envelope(T3, F1), { SLIM_TTL: '1', FND_MCP_SLIM_TTL: '72' });
  check('S17-ttl-own-swept', !existsSync(`${T3}/spill/fnd-crush-dead.json`), 'SLIM_TTL=1 kept a 48 h file');
  const T4 = newT();
  seed(T4);
  call('S17-ttl-fnd0', T4, envelope(T4, F1), { FND_MCP_SLIM_TTL: '0' });
  check('S17-ttl-fnd0-ignored', !existsSync(`${T4}/spill/fnd-crush-dead.json`), 'FND_MCP_SLIM_TTL=0 stopped slim\'s sweep');
}
{
  const T = newT();
  const a = call('S19', T, envelope(T, F1, { pre: 'size-gate', bytes_in: 9999 }));
  eq('S19-pre', [a.decision, a.reason], ['passthrough', 'size-gate']);
  eq('S19-line', logLines(`${T}/spill`).map((l) => [l.reason, l.bytes_in, l.bytes_out]), [['size-gate', 9999, 9999]]);
  eq('S19-tree-not-run', mcpSpills(`${T}/spill`), []);
  const T2 = newT();
  const b = call('S19b', T2, envelope(T2, null, { pre: 'already-slim', bytes_in: 5000 }), { SLIM_DEBUG: '1' });
  eq('S19b-pre-quiet', [b.decision, b.reason, logLines(`${T2}/spill`).length], ['passthrough', 'already-slim', 0]);
}
{
  const require = createRequire(import.meta.url);
  const { capAnswer, OUTPUT_CAP } = require(SLIM);
  eq('S20-cap-value', OUTPUT_CAP, 4_128_768);
  const answer = {
    decision: 'compressed', reason: null, result: 'x'.repeat(500), figure: 'slim: compressed 1,000 B → 200 B (−80.0%)',
    record: { src: 'slim', channel: 'mcp', entry: 'hook', tool: 't', decision: 'compressed', reason: null, engine: 'json', bytes_in: 1000, bytes_out: 200, pct: 80, stages: [], spill: '/s', spills: ['/s'], ms: 1 },
  };
  const c = capAnswer(answer, 100);
  eq('S20-capped', [c.decision, c.reason, 'result' in c], ['passthrough', 'output-cap', false]);
  eq('S20-record', [c.record.decision, c.record.reason, c.record.engine, c.record.bytes_out, c.record.pct, c.record.spill], ['passthrough', 'output-cap', null, 1000, 0, null]);
  check('S20-under-cap', capAnswer(answer) === answer, 'an answer under the cap must come back as is');
}
{
  const T = newT();
  spawn(T, '{not json', { extra: { SLIM_DEBUG: undefined } });
  eq('S21-error-at-level-0', logLines(`${T}/spill`).map((l) => [l.decision, l.lvl]), [['error', 0]]);
}
// The envelope keys as the hooks module writes them and as its kit test pins them, against this suite's.
{
  const kit = /const ENVELOPE_KEYS = (\[[^\]]*\])/.exec(readFileSync(path.join(MODS, 'tests/mcp.test.ts'), 'utf8'));
  eq('S23-kit-keys', kit && JSON.parse(kit[1].replace(/'/g, '"')), ENVELOPE_KEYS);
  const src = readFileSync(path.join(MODS, 'intake.ts'), 'utf8');
  const block = /const envelope = \{\n([\s\S]*?)\n {4}\}\n/.exec(src);
  const keys = [];
  for (const line of (block ? block[1] : '').split('\n')) for (const m of line.matchAll(/(?:^\s*|[{,]\s*)([A-Za-z_]\w*)\s*(?=[:,}])/g)) keys.push(m[1]);
  eq('S23-mod-keys', keys, ENVELOPE_KEYS);
  const T = newT();
  eq('S23-envelope-keys', Object.keys(envelope(T, F1)), M1_KEYS);
}

// The hooks module's pre-filter sizes and the core's channel table must agree.
{
  const lit = /export const GATES = (\{[^}]*\}) as const/.exec(readFileSync(path.join(MODS, 'channels.ts'), 'utf8'));
  const mod = lit ? JSON.parse(lit[1].replace(/(\w+):/g, '"$1":')) : null;
  const require = createRequire(import.meta.url);
  eq('S24-gates', mod, require(path.join(SCRIPTS, 'delivery/channels.cjs')).GATES);
  const fetchLit = /export const FETCH_CMD = (\/.*\/)\n/.exec(readFileSync(path.join(MODS, 'channels.ts'), 'utf8'));
  eq('S24-fetch-cmd', fetchLit && fetchLit[1], String(require(path.join(SCRIPTS, 'delivery/channels.cjs')).FETCH_CMD));
}

// P: the engines produce exactly what the frozen compressor did on the real fixtures.
{
  const require = createRequire(import.meta.url);
  const { compress } = require(path.join(SCRIPTS, 'engines/index.cjs'));
  const frozen = require(FROZEN_JSON);
  const T = newT();
  const spillDir = path.join(T, 'p');
  const names = { original: 'fnd-mcp-slim-', rows: 'fnd-crush-', ids: 'fnd-jsx-ids-' };
  const inputs = { F1, F3, F4, F5, REST: readFileSync(path.join(FIX, 'figma-node-rest.json'), 'utf8') };
  F2.forEach((b, i) => { if (b && typeof b.text === 'string') inputs[`F2-${i}`] = b.text; });
  for (const [k, text] of Object.entries(inputs)) {
    const old = frozen.slim(text, { spillDir });
    const r = compress({ data: text }, { engine: 'json', spillDir, spillNames: names, maxMs: 0 });
    const oldOut = old.wasModified && old.bytesOut < old.bytesIn ? old.output : null;
    eq(`P-${k}`, r.decision === 'compressed' ? r.text : null, oldOut);
    // The parts the text cites carry exactly the bytes the frozen compressor wrote under those names.
    for (const p of r.parts || []) {
      const file = path.join(spillDir, p.suggestedName);
      check(`P-${k}-part-${p.kind}`, existsSync(file) && readFileSync(file, 'utf8') === p.payload, file);
    }
  }
}

const HOST = (T) => path.join(T, 'cfg/projects/p/s1/tool-results');
const hostFile = (T, name, text) => { mkdirSync(HOST(T), { recursive: true }); const f = path.join(HOST(T), name); writeFileSync(f, text); return f; };
function chEnv(T, channel, tool, toolInput, response, extra = {}) {
  return envelope(T, response, { channel, tool, tool_input: toolInput, ...extra });
}
const bodyOf = (s) => String(s).split('\n\nslim: compressed ')[0];
const ORDERS = (n) => spawnSync('node', [path.join(ROOT, 'plugins/slim/evals/_shared/make-orders.cjs'), String(n)], { encoding: 'utf8' }).stdout;
const PAGE = readFileSync(path.join(FIX, 'page.html'), 'utf8');
const APPLOG = readFileSync(path.join(FIX, 'app.log'), 'utf8');
const TESTOUT = readFileSync(path.join(FIX, 'test-output.txt'), 'utf8');
const DIFF = readFileSync(path.join(FIX, 'git-diff.txt'), 'utf8');
const GO_TEST = (() => {
  const l = [];
  for (let i = 0; l.join('\n').length < 70000; i++) {
    l.push(`=== RUN   TestCheckout/case_${i}`, `    checkout_test.go:${40 + (i % 90)}: cart total ${(i * 7) % 300}`, `--- PASS: TestCheckout/case_${i} (0.0${i % 9}s)`);
  }
  l.push('FAIL', 'FAIL\tgithub.com/northwind/shop/checkout\t3.412s', 'ok  \tgithub.com/northwind/shop/catalog\t0.981s');
  return l.join('\n');
})();
const BASH = (stdout, extra = {}) => ({ stdout, stderr: '', interrupted: false, isImage: false, ...extra });

// C-bash
{
  const T = newT();
  const a = call('Cb1', T, chEnv(T, 'bash', 'Bash', { command: 'curl -s https://elc.atlassian.net/rest/api/3/search' }, BASH(F1, { stderr: 'warn: slow', interrupted: false })));
  eq('Cb1-json', [a.decision, a.reason, a.record.engine, a.record.channel], ['compressed', null, 'json', 'bash']);
  const res = a.result || {};
  eq('Cb1-shape', [res.stderr, res.interrupted, 'persistedOutputPath' in res, 'persistedOutputSize' in res, typeof res.stdout], ['warn: slow', false, false, false, 'string']);
  check('Cb1-handle', !!handleOf(res.stdout || '') && readFileSync(handleOf(res.stdout), 'utf8') === F1, String(res.stdout).slice(-160));
  eq('Cb1-figure', figureOf(res.stdout || ''), bytes(res.stdout || ''));

  const b = call('Cb2', T, chEnv(T, 'bash', 'Bash', { command: 'npx jest --ci' }, BASH(TESTOUT)));
  eq('Cb2-test-output-untouched', [b.decision, b.reason], ['passthrough', 'plain-gate']);
  const b8 = call('Cb2-8k', T, chEnv(T, 'bash', 'Bash', { command: 'npx jest --ci' }, BASH(TESTOUT)), { SLIM_PLAIN_BYTES: '8192' });
  const w = bodyOf((b8.result || {}).stdout);
  const lines = TESTOUT.replace(/\n$/, '').split('\n');
  eq('Cb2-8k-window', [b8.decision, b8.record.engine], ['compressed', 'text']);
  check('Cb2-8k-head-tail-verbatim', w.startsWith(lines.slice(0, 5).join('\n')) && w.includes(lines.slice(-5).join('\n')) && /\n\[slim: [\d,]+ of [\d,]+ lines hidden \([\d,]+ B\)\]\n/.test(w), w.slice(0, 200));
  check('Cb2-8k-lines-unchanged', w.split('\n').filter((l) => !l.startsWith('[slim: ')).every((l) => lines.includes(l)), 'a line was rewritten');
  check('Cb2-8k-record-window', b8.record.window && b8.record.window.lines_total === TESTOUT.split('\n').length && b8.record.window.lines_hidden > 0, JSON.stringify(b8.record.window));

  const d = call('Cb3', T, chEnv(T, 'bash', 'Bash', { command: 'git diff main' }, BASH(DIFF)));
  eq('Cb3-diff-untouched', [d.decision, d.reason], ['passthrough', 'plain-gate']);
  const d8 = call('Cb3-8k', T, chEnv(T, 'bash', 'Bash', { command: 'git diff main' }, BASH(DIFF)), { SLIM_PLAIN_BYTES: '8192' });
  const dl = DIFF.split('\n');
  check('Cb3-8k-window-only', d8.record.engine === 'text' && bodyOf(d8.result.stdout).split('\n').filter((l) => !l.startsWith('[slim: ')).every((l) => dl.includes(l)), d8.record.engine);

  const go = hostFile(T, 'b0.txt', GO_TEST);
  const g = call('Cb4', T, chEnv(T, 'bash', 'Bash', { command: 'go test ./...' }, BASH(GO_TEST.slice(0, 2048), { persistedOutputPath: go, persistedOutputSize: bytes(GO_TEST) })));
  eq('Cb4-persisted', [g.decision, g.reason, g.record.engine], ['compressed', 'mod-expand', 'text']);
  const gs = (g.result || {}).stdout || '';
  check('Cb4-window-4096', bytes(bodyOf(gs)) <= 4096 && gs.includes('ok  \tgithub.com/northwind/shop/catalog\t0.981s'), String(bytes(bodyOf(gs))));
  check('Cb4-seen', Number.isFinite(g.record.bytes_seen) && g.record.bytes_seen < 2600 && g.record.pct === Math.round((1 - g.record.bytes_out / g.record.bytes_seen) * 1000) / 10, JSON.stringify(g.record));
  eq('Cb4-no-persisted-keys', ['persistedOutputPath' in (g.result || {}), 'persistedOutputSize' in (g.result || {})], [false, false]);
  eq('Cb4-handle-is-host-file', handleOf(gs), realpathSync(go));

  const pg = hostFile(T, 'b1.txt', PAGE);
  const persistedPage = BASH(PAGE.slice(0, 2048), { persistedOutputPath: pg, persistedOutputSize: bytes(PAGE) });
  const h = call('Cb5', T, chEnv(T, 'bash', 'Bash', { command: 'curl -s https://shop.example/p' }, persistedPage));
  eq('Cb5-html', [h.decision, h.reason, h.record.engine, h.record.hint], ['compressed', 'mod-expand', 'html', true]);
  const hs = (h.result || {}).stdout || '';
  check('Cb5-hint', hs.includes('\n\nslim hint: for one fact about this page, call mcp__slim__lookup({ url: "https://shop.example/p", question: "…" }) instead of reading it whole\n\nslim: compressed '), hs.slice(-400));
  check('Cb5-html-body', hs.includes('# Northwind Ceramics — Spring Catalogue') && hs.includes('scripts (6):') && !hs.includes('SENTINEL-STYLE-9Q'), hs.slice(0, 200));
  for (const [k, v] of [['SLIM_HINT', '0'], ['SLIM_LOOKUP', '0']]) {
    const n = call(`Cb5-${k}`, T, chEnv(T, 'bash', 'Bash', { command: 'curl -s https://shop.example/p' }, persistedPage), { [k]: v });
    check(`Cb5-${k}-no-hint`, n.decision === 'compressed' && !((n.result || {}).stdout || '').includes('slim hint:') && !n.record.hint, n.decision);
  }
  const c = call('Cb6', T, chEnv(T, 'bash', 'Bash', { command: 'cat page.html' }, persistedPage));
  check('Cb6-cat-page-is-text', c.record.engine !== 'html', `${c.decision} ${c.record.engine}`);
  for (const cmd of ['cat src/http/page.html', 'cat docs/https-setup.html', 'cat ~/work/http-server/public/index.html']) {
    const x = call('Cb6-path-word', T, chEnv(T, 'bash', 'Bash', { command: cmd }, persistedPage));
    check(`Cb6-path-word-${cmd}`, x.record.engine !== 'html', `${x.decision} ${x.record.engine}`);
  }
  const fu = call('Cb5-file', T, chEnv(T, 'bash', 'Bash', { command: 'curl -s file://$PWD/page.html' }, persistedPage));
  check('Cb5-file-hint-absolute', fu.record.engine === 'html' && ((fu.result || {}).stdout || '').includes(`lookup({ path: ${JSON.stringify(path.join(T, 'page.html'))}, question`), ((fu.result || {}).stdout || '').slice(-400));
  const fx2 = call('Cb5-file-x', T, chEnv(T, 'bash', 'Bash', { command: 'curl -s file://$HOME/page.html' }, persistedPage));
  check('Cb5-file-unresolved-no-hint', fx2.record.engine === 'html' && !fx2.record.hint, JSON.stringify(fx2.record));

  const lg = hostFile(T, 'b2.txt', APPLOG);
  const l = call('Cb7', T, chEnv(T, 'bash', 'Bash', { command: 'cat app.log' }, BASH(APPLOG.slice(0, 2048), { persistedOutputPath: lg, persistedOutputSize: bytes(APPLOG) })));
  eq('Cb7-log', [l.decision, l.record.engine], ['compressed', 'log']);

  const evil = path.join(T, 'evil.txt');
  writeFileSync(evil, GO_TEST);
  const f = call('Cb8', T, chEnv(T, 'bash', 'Bash', { command: 'go test ./...' }, BASH('x', { persistedOutputPath: evil, persistedOutputSize: bytes(GO_TEST) })));
  eq('Cb8-forged', [f.decision, f.reason], ['passthrough', 'expand-refused']);
  eq('Cb8-image', call('Cb8-img', T, chEnv(T, 'bash', 'Bash', { command: 'cat a.png' }, BASH(F1, { isImage: true }))).reason, 'not-text');

  mkdirSync(path.join(T, 'spill'), { recursive: true });
  const sp = path.join(T, 'spill', 'fnd-mcp-slim-0123456789abcdef.json');
  writeFileSync(sp, F1);
  eq('Cb9-spill-read', call('Cb9', T, chEnv(T, 'bash', 'Bash', { command: `cat ${sp}` }, BASH(F1))).reason, 'spill-read');
  eq('Cb9-host-read', call('Cb9h', T, chEnv(T, 'bash', 'Bash', { command: `head -c 99999 ${go}` }, BASH(GO_TEST))).reason, 'spill-read');
  eq('Cb10-own-cli', call('Cb10', T, chEnv(T, 'bash', 'Bash', { command: `node ${FROZEN_JSON} f.json --jq .a` }, BASH(F1))).reason, 'own-cli');
  eq('Cb11-source-json', call('Cb11', T, chEnv(T, 'bash', 'Bash', { command: 'cat templates/product.json' }, BASH(F1))).reason, 'read-guard');
  const rn = call('Cb14', T, chEnv(T, 'bash', 'Bash', { command: 'cat AbC123-3326-39542.nodes.json' }, BASH(REST)));
  check('Cb14-figma-nodes', rn.decision === 'compressed' && rn.record.engine === 'figma-nodes' && String((rn.result || {}).stdout).startsWith('# figma node 3326:39542'), `${rn.decision} ${rn.record.engine}`);
  const rb = call('Cb15', T, chEnv(T, 'bash', 'Bash', { command: 'cat AbC123-3326-1.nodes.json' }, BASH(REST_BIG)));
  check('Cb15-big-nodes', ['compressed', 'stubbed'].includes(rb.decision) && rb.record.engine !== 'figma-nodes' && bytes(String((rb.result || {}).stdout)) <= 32768 + 1024, `${rb.decision} ${rb.reason} ${rb.record.engine} ${rb.record.bytes_out}`);

  const rows = [];
  for (let i = 0; rows.join(',').length < 300000; i++) rows.push({ id: `${i}-${'abcdef0123456789'.repeat(1 + (i % 5)).slice(i % 7)}`, body: `unique text ${i} ${'lorem ipsum '.repeat(8 + (i % 13))}${i * 7919}`, a: null, b: null, c: {}, d: [] });
  const fit = call('Cb12-fit', T, chEnv(T, 'bash', 'Bash', { command: 'curl -s https://api.example/rows' }, BASH(JSON.stringify({ rows }))));
  eq('Cb12-fit', [fit.decision, fit.record.engine, (fit.record.stages || []).includes('fit')], ['compressed', 'json', true]);
  // No row array to fit: the compressed view stays over the egress cap and is stubbed.
  const big = JSON.stringify(Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`k${i}`, { token: `${i}-`.repeat(400), gone: null }])));
  const st = call('Cb12', T, chEnv(T, 'bash', 'Bash', { command: 'curl -s https://api.example/rows' }, BASH(big)));
  eq('Cb12-egress-stub', [st.decision, st.reason, st.record.engine], ['stubbed', 'egress-cap', 'stub']);
  const ss = (st.result || {}).stdout || '';
  check('Cb12-stub-text', ss.startsWith('<<slim stub>> Bash returned ') && /^slim: stub [\d,]+ B → [\d,]+ B/m.test(ss) && bytes(ss) <= 1300, ss.slice(0, 200));
  const sf = /^full=(\S+)$/m.exec(ss);
  check('Cb12-stub-spill', !!sf && readFileSync(sf[1], 'utf8') === big, sf && sf[1]);

  const slimmed = (a.result || {}).stdout || '';
  const back = call('Cb13', T, chEnv(T, 'bash', 'Bash', { command: 'cat out.txt' }, BASH(`${slimmed}`)), { SLIM_STUB_BYTES: '1200' });
  eq('Cb13-already-slim', [back.decision, back.reason], ['passthrough', 'already-slim']);
}

// C-read
{
  const T = newT();
  const orders = ORDERS(380);
  check('Cr-orders-300k', bytes(orders) > 300000, String(bytes(orders)));
  mkdirSync(path.join(T, 'data'), { recursive: true });
  const fp = path.join(T, 'data', 'orders.json');
  writeFileSync(fp, orders);
  const page = orders.slice(0, 20000);
  const readRec = (filePath, content, x = {}) => ({ type: 'text', file: { filePath, content, numLines: content.split('\n').length, startLine: 1, totalLines: orders.split('\n').length, ...x } });
  const a = call('Cr1', T, chEnv(T, 'read', 'Read', { file_path: fp }, readRec(fp, page, { truncatedByTokenCap: true })));
  eq('Cr1-compressed', [a.decision, a.record.engine, a.record.channel, a.record.bytes_in], ['compressed', 'json', 'read', bytes(orders)]);
  const f = (a.result || {}).file || {};
  eq('Cr1-shape', [a.result && a.result.type, f.filePath, f.startLine, f.numLines === String(f.content).split('\n').length, 'truncatedByTokenCap' in f, f.totalLines], ['text', fp, 1, true, false, orders.split('\n').length]);
  check('Cr1-note', String(f.content).includes(`\n\nslim: this view of ${fp} is compressed and its line numbers are not file lines — Read it with offset/limit for exact bytes before an Edit or Write\n\nslim: compressed `), String(f.content).slice(-400));
  const h = handleOf(String(f.content));
  check('Cr1-copy', !!h && /\/spill\/fnd-mcp-slim-[0-9a-f]{16}\.json$/.test(h) && readFileSync(h, 'utf8') === orders, h);
  check('Cr1-sentinel-dropped', !String(f.content).includes('SENTINEL-ORDER-0217'), 'sentinel kept');
  eq('Cr2-not-truncated', call('Cr2', T, chEnv(T, 'read', 'Read', { file_path: fp }, readRec(fp, orders))).reason, 'read-guard');
  const tpl = path.join(T, 'templates');
  mkdirSync(tpl, { recursive: true });
  writeFileSync(path.join(tpl, 'x.json'), orders);
  eq('Cr3-source-json', call('Cr3', T, chEnv(T, 'read', 'Read', { file_path: path.join(tpl, 'x.json') }, readRec(path.join(tpl, 'x.json'), page, { truncatedByTokenCap: true }))).reason, 'read-guard');
  const code = readFileSync(SLIM, 'utf8');
  eq('Cr3-code', call('Cr3c', T, chEnv(T, 'read', 'Read', { file_path: SLIM }, readRec(SLIM, code, { truncatedByTokenCap: true }))).reason, 'read-guard');
  eq('Cr4-offset', call('Cr4', T, chEnv(T, 'read', 'Read', { file_path: fp, offset: 10 }, readRec(fp, page, { truncatedByTokenCap: true }))).reason, 'windowed-read');
  eq('Cr5-spill-read', call('Cr5', T, chEnv(T, 'read', 'Read', { file_path: h }, readRec(h, page, { truncatedByTokenCap: true }))).reason, 'spill-read');
  const logp = path.join(T, 'data', 'app.log');
  const log60 = APPLOG.slice(0, 61440);
  writeFileSync(logp, log60);
  const l = call('Cr6', T, chEnv(T, 'read', 'Read', { file_path: logp }, readRec(logp, log60)));
  eq('Cr6-log', [l.decision, l.record.engine], ['compressed', 'log']);
  eq('Cr7-page', call('Cr7', T, chEnv(T, 'read', 'Read', { file_path: path.join(FIX, 'page.html') }, readRec(path.join(FIX, 'page.html'), PAGE))).reason, 'read-guard');
  eq('Cr8-image', call('Cr8', T, chEnv(T, 'read', 'Read', { file_path: '/x.png' }, { type: 'image', file: { base64: 'AAAA', type: 'image/png', originalSize: 4 } })).reason, 'not-text');
  // A Figma REST nodes response is JSON the read channel admits, compressed by its own engine.
  const np = path.join(T, 'data', 'AbC123-3326-39542.nodes.json');
  writeFileSync(np, REST);
  const n = call('Cr9', T, chEnv(T, 'read', 'Read', { file_path: np }, { type: 'text', file: { filePath: np, content: REST.slice(0, 20000), numLines: 1, startLine: 1, totalLines: 1, truncatedByTokenCap: true } }));
  eq('Cr9-figma-nodes', [n.decision, n.record.engine, n.record.bytes_in], ['compressed', 'figma-nodes', bytes(REST)]);
  const nc = String(((n.result || {}).file || {}).content);
  const nh = handleOf(nc);
  check('Cr9-tree', nc.startsWith('# figma node 3326:39542 — ') && nc.includes('\nnodes: 303 visible · 0 hidden dropped · 0 folded\n'), nc.slice(0, 300));
  check('Cr9-spill-json', !!nh && /\/spill\/fnd-mcp-slim-[0-9a-f]{16}\.json$/.test(nh) && readFileSync(nh, 'utf8') === REST, nh);
  // A node tree still over the egress cap takes the JSON route (fit, else stub), never raw passthrough.
  const bp = path.join(T, 'data', 'AbC123-3326-1.nodes.json');
  writeFileSync(bp, REST_BIG);
  const bn = call('Cr10', T, chEnv(T, 'read', 'Read', { file_path: bp }, { type: 'text', file: { filePath: bp, content: REST_BIG.slice(0, 20000), numLines: 1, startLine: 1, totalLines: 1, truncatedByTokenCap: true } }));
  const bc = String(((bn.result || {}).file || {}).content);
  check('Cr10-big-nodes', ['compressed', 'stubbed'].includes(bn.decision) && bn.record.engine !== 'figma-nodes' && bn.record.bytes_out <= 65536 && bytes(bc) <= 65536 + 1024, `${bn.decision} ${bn.reason} ${bn.record.engine} ${bn.record.bytes_out}`);
  const bh = handleOf(bc) || (/^full=(\S+)$/m.exec(bc) || [])[1];
  check('Cr10-spill-json', !!bh && /\.json$/.test(bh) && readFileSync(bh, 'utf8') === REST_BIG, bh);
}

// C-webfetch, C-websearch, C-grep, C-glob, C-agent
{
  const T = newT();
  const wf = { bytes: bytes(PAGE), code: 200, codeText: 'OK', result: PAGE, durationMs: 120, url: 'https://shop.example/p' };
  const a = call('Cw1', T, chEnv(T, 'webfetch', 'WebFetch', { url: 'https://shop.example/p', prompt: 'list the scripts' }, wf));
  eq('Cw1-html', [a.decision, a.record.engine, a.record.channel], ['compressed', 'html', 'webfetch']);
  eq('Cw1-keys', Object.keys(a.result || {}), Object.keys(wf));
  check('Cw1-result', String((a.result || {}).result).startsWith('# Northwind Ceramics') && (a.result || {}).url === wf.url, String((a.result || {}).result).slice(0, 80));
  const wn = call('Cw2', T, chEnv(T, 'webfetch', 'WebFetch', { url: 'https://api.figma.example/v1/files/K/nodes', prompt: 'raw' }, { ...wf, bytes: bytes(REST), result: REST }));
  eq('Cw2-figma-nodes', [wn.decision, wn.record.engine, String((wn.result || {}).result).startsWith('# figma node 3326:39542')], ['compressed', 'figma-nodes', true]);
  const wb = call('Cw3', T, chEnv(T, 'webfetch', 'WebFetch', { url: 'https://api.figma.example/v1/files/K/nodes', prompt: 'raw' }, { ...wf, bytes: bytes(REST_BIG), result: REST_BIG }));
  check('Cw3-big-nodes', ['compressed', 'stubbed'].includes(wb.decision) && wb.record.engine !== 'figma-nodes' && bytes(String((wb.result || {}).result)) <= 32768 + 1024, `${wb.decision} ${wb.reason} ${wb.record.engine} ${wb.record.bytes_out}`);

  const huge = Array.from({ length: 2500 }, (_, i) => `Result ${i}: northwind ceramics review number ${i} — ${'text '.repeat(6)}`).join('\n');
  const ws = { query: 'northwind ceramics', results: [{ tool_use_id: 'srv_1', content: [{ title: 'x', url: 'https://a.example' }] }, huge, 'short summary'], durationSeconds: 2.1 };
  const b = call('Cs1', T, chEnv(T, 'websearch', 'WebSearch', { query: 'northwind ceramics' }, ws));
  eq('Cs1-window', [b.decision, b.record.engine, b.record.channel], ['compressed', 'text', 'websearch']);
  const br = b.result || {};
  check('Cs1-others-untouched', JSON.stringify(br.results[0]) === JSON.stringify(ws.results[0]) && br.results[2] === 'short summary' && /\[slim: [\d,]+ of 2,500 lines hidden/.test(br.results[1]) && br.query === ws.query, JSON.stringify(br).slice(0, 200));

  const content = Array.from({ length: 3000 }, (_, i) => `src/components/card-${i % 40}/index-${i}.ts:${10 + (i % 300)}:  const price = item.price * qty; // ${i}`).join('\n');
  const g = call('Cg1', T, chEnv(T, 'grep', 'Grep', { pattern: 'price', output_mode: 'content' }, { mode: 'content', numFiles: 40, filenames: [], content, numLines: 3000, numMatches: 3000 }));
  eq('Cg1-window', [g.decision, g.record.engine, (g.result || {}).numMatches, (g.result || {}).numLines, (g.result || {}).numFiles], ['compressed', 'text', 3000, 3000, 40]);
  check('Cg1-marker', /\[slim: [\d,]+ of 3,000 lines hidden/.test((g.result || {}).content) && bytes(bodyOf((g.result || {}).content)) <= 8192, '');
  const files = Array.from({ length: 3000 }, (_, i) => `/repo/src/components/card-${i % 40}/part-${i}.liquid`);
  const gf = call('Cg2', T, chEnv(T, 'grep', 'Grep', { pattern: 'price' }, { mode: 'files_with_matches', numFiles: 3000, filenames: files }));
  const fl = (gf.result || {}).filenames || [];
  check('Cg2-files', gf.decision === 'compressed' && Array.isArray(fl) && fl[0] === files[0] && fl.some((x) => /^\[slim: [\d,]+ of 3,000 lines hidden/.test(x)) && (gf.result || {}).numFiles === 3000, `${gf.decision} ${fl.length}`);
  const gl = call('Cl1', T, chEnv(T, 'glob', 'Glob', { pattern: '**/*.liquid' }, { durationMs: 40, numFiles: 3000, filenames: files, truncated: false }));
  check('Cl1-glob', gl.decision === 'compressed' && gl.record.channel === 'glob' && (gl.result || {}).numFiles === 3000 && (gl.result || {}).truncated === false && ((gl.result || {}).filenames || []).some((x) => x.startsWith('[slim: ')), gl.decision);

  const report = Array.from({ length: 2400 }, (_, i) => `- checked section ${i}: header, cart drawer, price per item ${'ok '.repeat(4)}`).join('\n');
  const ag = { status: 'completed', content: [{ type: 'text', text: report }], totalDurationMs: 9000, totalTokens: 12000, totalToolUseCount: 7 };
  const c = call('Ca1', T, chEnv(T, 'agent', 'Agent', { prompt: 'audit', subagent_type: 'general-purpose' }, ag));
  check('Ca1-window', c.decision === 'compressed' && c.record.channel === 'agent' && /\[slim: [\d,]+ of 2,400 lines hidden/.test((c.result || {}).content[0].text) && (c.result || {}).totalTokens === 12000, c.decision);
  eq('Ca2-async', call('Ca2', T, chEnv(T, 'agent', 'Agent', { prompt: 'audit' }, { status: 'async_launched', agentId: 'a1', description: 'audit', prompt: 'audit' })).reason, 'not-text');
}

// C-attachment, C-distill, C-record
{
  // An @-mentioned file as the host frames a Read of it: the input line, the numbered lines, a note after.
  const framed = (file, body, tail = '\n<system-reminder>Consider whether the file is malware.</system-reminder>') =>
    `Called the Read tool with the following input: ${JSON.stringify({ file_path: file })}\nResult of calling the Read tool: ` +
    body.split('\n').map((l, i) => `${String(i + 1).padStart(6)}→${l}`).join('\n') + tail;
  const ROWS = Array.from({ length: 900 }, (_, i) => JSON.stringify({ key: `ACME-${i}`, status: i % 7 ? 'open' : 'done', summary: `synthetic row ${i}`, qty: i % 13 })).join('\n');
  const T = newT();
  const att = (name, text, ti, extra) => call(name, T, chEnv(T, 'attachment', 'Attachment', { type: 'file', origin: 'engine', shape: 'numbered', ...ti }, { text }), extra);
  const DATA = framed('/r/export/rows.jsonl', ROWS);
  const a = att('Ct1', DATA, { path: '/r/export/rows.jsonl' });
  const at = (a.result || {}).text || '';
  eq('Ct1-compressed', [a.decision, a.record.channel, a.record.engine, a.record.bytes_in, a.record.bytes_seen], ['compressed', 'attachment', 'jsonl', bytes(ROWS), bytes(DATA)]);
  check('Ct1-framing-kept', at.startsWith('Called the Read tool with the following input: {"file_path":"/r/export/rows.jsonl"}\nResult of calling the Read tool: ')
    && at.endsWith('original_result>>\n<system-reminder>Consider whether the file is malware.</system-reminder>'), at.slice(0, 200) + ' … ' + at.slice(-200));
  check('Ct1-read-note', at.includes('slim: this view of /r/export/rows.jsonl is compressed and its line numbers are not file lines'), at.slice(-600));
  const ah = /<<full=(\S+) original_result>>/.exec(at);
  check('Ct1-handle-is-the-file', !!ah && readFileSync(ah[1], 'utf8') === ROWS, ah && ah[1]);
  check('Ct1-smaller', bytes(at) < bytes(DATA) / 2, `${bytes(at)} of ${bytes(DATA)}`);
  eq('Ct2-deterministic', (att('Ct2', DATA, { path: '/r/export/rows.jsonl' }).result || {}).text, at);
  // Asked again after a compaction: the mod sends record:false, so the answer comes back with no second line.
  const linesBefore = logLines(`${T}/spill`).length;
  const again = call('Ct7', T, { ...chEnv(T, 'attachment', 'Attachment', { type: 'file', origin: 'engine', shape: 'numbered', path: '/r/export/rows.jsonl' }, { text: DATA }), record: false });
  eq('Ct7-asked-again-no-line', [(again.result || {}).text === at, logLines(`${T}/spill`).length - linesBefore], [true, 0]);
  const pretty = framed('/r/export/orders.json', JSON.stringify(JSON.parse(ORDERS(240)), null, 2));
  eq('Ct3-json', [att('Ct3', pretty, { path: '/r/export/orders.json' }).decision], ['compressed']);
  const src = framed('/r/src/big.ts', Array.from({ length: 3000 }, (_, i) => `const v${i} = ${i};`).join('\n'));
  const pkg = framed('/r/package.json', JSON.stringify(JSON.parse(ORDERS(240)), null, 2));
  eq('Ct4-passes', [att('Ct4a', src, { path: '/r/src/big.ts' }).reason, att('Ct4b', pkg, { path: '/r/package.json' }).reason, att('Ct4c', ROWS, { shape: 'raw' }).reason],
    ['read-guard', 'read-guard', 'read-guard']);
  eq('Ct5-no-framing-by-content', att('Ct5', DATA.slice(DATA.indexOf('\n') + 1), {}).decision, 'compressed');
  const T1 = newT();
  call('Ct6', T1, chEnv(T1, 'attachment', 'Attachment', { type: 'file', origin: 'engine', shape: 'raw' }, null, { pre: 'read-guard', bytes_in: 70000 }));
  eq('Ct6-pre-line-at-2', logLines(`${T1}/spill`).map((l) => [l.channel, l.reason, l.bytes_in]), [['attachment', 'read-guard', 70000]]);
  const T1b = newT();
  call('Ct6b', T1b, chEnv(T1b, 'attachment', 'Attachment', { type: 'file', origin: 'engine', shape: 'raw' }, null, { pre: 'read-guard', bytes_in: 70000 }), { SLIM_DEBUG: '1' });
  eq('Ct6-none-at-1', logLines(`${T1b}/spill`).length, 0);

  const T2 = newT();
  const d = spawn(T2, JSON.stringify({ v: 1, text: PAGE, hint: { source: 'https://shop.example/p' }, cwd: T2, session_id: 's1' }), { args: ['--distill'] });
  let dj = null;
  try { dj = JSON.parse(d.stdout); } catch (_) {}
  check('Cd1-html', d.status === 0 && dj && dj.v === 1 && dj.engine === 'html' && dj.decision === 'compressed' && dj.text.startsWith('# Northwind') && dj.bytesOut <= 49152, d.stdout.slice(0, 200));
  check('Cd1-writes-nothing', !existsSync(path.join(T2, 'spill')), 'distill wrote into the spill dir');
  const big = APPLOG + APPLOG;
  const host = hostFile(T2, 'd1.txt', big);
  const d2 = spawn(T2, JSON.stringify({ v: 1, host_path: host, budgetBytes: 8192, cwd: T2, session_id: 's1' }), { args: ['--distill'] });
  let d2j = null;
  try { d2j = JSON.parse(d2.stdout); } catch (_) {}
  check('Cd2-host', d2j && d2j.engine === 'log' && d2j.bytesIn === bytes(big) && d2j.bytesOut <= 8192, d2.stdout.slice(0, 200));
  const d3 = spawn(T2, JSON.stringify({ v: 1, host_path: path.join(T2, 'x.txt'), cwd: T2, session_id: 's1' }), { args: ['--distill'] });
  check('Cd3-forged-host', JSON.parse(d3.stdout || '{}').decision === 'refused', d3.stdout);
  const d4 = spawn(T2, JSON.stringify({ v: 1, path: path.join(FIX, 'git-diff.txt'), budgetBytes: 8192, cwd: T2, session_id: 's1' }), { args: ['--distill'] });
  check('Cd4-path', JSON.parse(d4.stdout || '{}').bytesOut <= 8192, d4.stdout.slice(0, 120));
  check('Cd5-no-log', !existsSync(path.join(T2, 'spill', LOG)), 'distill logged');
  // A crush would cite rows by a file distill never writes: the rows come back inline, windowed.
  const d6 = spawn(T2, JSON.stringify({ v: 1, text: ORDERS(240), cwd: T2, session_id: 's1' }), { args: ['--distill'] });
  let d6j = null;
  try { d6j = JSON.parse(d6.stdout); } catch (_) {}
  check('Cd6-rows-inline', d6j && d6j.decision === 'compressed' && d6j.reason === 'rows-inline' && d6j.bytesOut <= 49152
    && d6j.text.includes('ORD-0001') && d6j.text.includes('SENTINEL-ORDER-0217') && !d6j.text.includes('<<full='), d6.stdout.slice(0, 200));

  const T3 = newT();
  const r = spawn(T3, JSON.stringify({ tool_use_id: 'toolu_r', decision: 'failed', reason: 'timeout', rung: 'url', engine: 'html', model: 'haiku', tokens: null, bytes_in: 5, bytes_out: 0, ms: 30000, cwd: T3 }), { args: ['--record'], extra: { SLIM_DEBUG: undefined } });
  check('Cr-record-exit', r.status === 0 && r.stdout === '', `exit ${r.status}`);
  eq('Cr-record-line', logLines(`${T3}/spill`).map((l) => [l.src, l.channel, l.entry, l.tool, l.tool_use_id, l.decision, l.reason, l.rung, l.engine, l.model, l.tokens, l.lvl]),
    [['slim', 'lookup', 'mod', 'mcp__slim__lookup', 'toolu_r', 'failed', 'timeout', 'url', 'html', 'haiku', null, 0]]);
}

// Cp — the prompt channel (--prompt): data spans of a pasted prompt replaced in place, spilled to the
// project's durable .claude/slim/prompt/, prose kept byte for byte; Cx — the spill access lines.
{
  const { jsonBlobs } = createRequire(import.meta.url)(path.join(SCRIPTS, 'engines/index.cjs'));
  const prompt = (T, text, root = T, extra = {}) => {
    const r = spawn(T, JSON.stringify({ v: 1, text, root, cwd: root, session_id: 's1' }), { args: ['--prompt'], extra });
    check(`Cp-exit-${T.slice(-6)}`, r.status === 0, `exit ${r.status} ${r.stderr}`);
    try { return JSON.parse(r.stdout); } catch (_) { return {}; }
  };
  const dirOf = (root) => path.join(root, '.claude/slim/prompt');
  const files = (root) => (existsSync(dirOf(root)) ? readdirSync(dirOf(root)).sort() : []);
  const ISSUES = JSON.stringify({ total: 400, issues: Array.from({ length: 400 }, (_, i) => ({ key: `ACME-${i}`, fields: { summary: `synthetic issue ${i}`, status: { name: i % 3 ? 'Open' : 'Done' } } })) }, null, 2);
  const HEAD = 'Hi — the search below returns the wrong total. Can you see why?\n\n';
  const TAIL = '\n\nWhich field is off? Thanks!';

  const T = newT();
  const p1 = prompt(T, HEAD + ISSUES + TAIL);
  eq('Cp1-rewritten', [p1.decision, p1.spans && p1.spans.map((x) => [x.kind, x.engine, x.form])], ['rewritten', [['json', 'json', 'inline']]]);
  check('Cp1-prose-byte-equal', typeof p1.text === 'string' && p1.text.startsWith(HEAD) && p1.text.endsWith(TAIL), String(p1.text).slice(0, 120));
  const h1 = /<<full=(\S+) original_result>>/.exec(p1.text || '');
  check('Cp1-spill-durable', !!h1 && path.dirname(h1[1]) === dirOf(T) && readFileSync(h1[1], 'utf8') === ISSUES && (statSync(h1[1]).mode & 0o777) === 0o600, h1 && h1[1]);
  check('Cp1-stats', /\n\nslim: compressed [\d,]+ B → [\d,]+ B \(−\d+\.\d%\)\n\n<<full=/.test(p1.text || ''), String(p1.text).slice(-400));
  check('Cp1-bound', jsonBlobs(p1.text || '', 8192).blobs.length === 0 && p1.bytesOut < p1.bytesIn / 2, `${p1.bytesOut} of ${p1.bytesIn}`);
  const line = logLines(`${T}/spill`).filter((l) => l.channel === 'prompt');
  eq('Cp1-report', line.map((l) => [l.src, l.channel, l.entry, l.tool, l.decision, l.engine, l.spans, l.spill]), [['slim', 'prompt', 'mod', 'prompt', 'compressed', 'json', 1, h1 && h1[1]]]);
  const p1b = prompt(T, HEAD + ISSUES + TAIL);
  eq('Cp1-same-paste-same-spill', [p1b.text === p1.text, files(T).filter((f) => /^slim-prompt-[0-9a-f]{16}\.json$/.test(f)).length], [true, 1]);
  eq('Cp1-created', [(p1.created || []).map((f) => path.basename(f).replace(/[0-9a-f]{16}/, 'H')), p1.created && p1.created[0] === (h1 && h1[1]), p1b.created],
    [['slim-prompt-H.json', 'slim-prompt-rows-H.json'], true, []]);
  eq('Cp1-no-journal-left', files(T).filter((f) => f.startsWith('.pending-')), []);
  // slim's own folder ignores itself, so `git add -A` never stages a paste; an existing .gitignore is kept.
  const ign = path.join(T, '.claude/slim/.gitignore');
  spawnSync('git', ['init', '-q', T], { encoding: 'utf8' });
  const ci = spawnSync('git', ['-C', T, 'check-ignore', '-q', h1 ? h1[1] : ''], { encoding: 'utf8' });
  eq('Cp1-gitignored', [existsSync(ign) && readFileSync(ign, 'utf8'), ci.status], ['*\n', 0]);
  writeFileSync(ign, '# mine\n');
  prompt(T, HEAD + ISSUES + TAIL);
  eq('Cp1-gitignore-kept', readFileSync(ign, 'utf8'), '# mine\n');

  // A JSON object the engine cannot bring under 8 KB: its head (cut, not parseable) and the handle.
  const WIDE = JSON.stringify(Object.fromEntries(Array.from({ length: 700 }, (_, i) => [`field_${i}_${(i * 7919).toString(36)}`, (i * 104729).toString(16).padStart(24, 'f')])), null, 1);
  const T2 = newT();
  const p2 = prompt(T2, `${HEAD}${WIDE}${TAIL}`);
  eq('Cp2-head', [p2.decision, p2.spans && p2.spans[0].form, p2.spans && p2.spans[0].engine], ['rewritten', 'head', 'stub']);
  check('Cp2-head-text', /\[slim: the rest of this pasted json is in the file below — [\d,]+ B in all; Read it windowed \(offset\/limit\) or call mcp__slim__view\(\{ path, jq \}\)\]\n\nslim: stub /.test(p2.text || ''), String(p2.text).slice(0, 300));
  check('Cp2-bound', jsonBlobs(p2.text || '', 8192).blobs.length === 0 && p2.text.startsWith(HEAD) && p2.text.endsWith(TAIL), 'a parseable span survived');
  eq('Cp2-report-stubbed', logLines(`${T2}/spill`).filter((l) => l.channel === 'prompt').map((l) => l.decision), ['stubbed']);

  // A log and a page between prose, each in place; the order of the spans holds.
  const LOGTXT = Array.from({ length: 500 }, (_, i) => `2026-10-08T10:${String(i % 60).padStart(2, '0')}:${String(i % 59).padStart(2, '0')}Z ${i % 9 ? 'INFO' : 'ERROR'} worker-${i % 4} job ${i % 17} ${i % 9 ? 'done' : 'failed: timeout'}`).join('\n');
  const T3 = newT();
  const p3 = prompt(T3, `Log:\n${LOGTXT}\n\nPage:\n${PAGE}\nWhat broke?`);
  eq('Cp3-log-and-html', [p3.decision, p3.spans && p3.spans.map((x) => [x.kind, x.form])], ['rewritten', [['log', 'inline'], ['html', 'inline']]]);
  check('Cp3-prose', p3.text.startsWith('Log:\n') && p3.text.includes('original_result>>\n\nPage:\n') && /original_result>>\n+What broke\?$/.test(p3.text), p3.text.slice(-300));
  eq('Cp3-spills', files(T3).filter((f) => /^slim-prompt-[0-9a-f]{16}\.txt$/.test(f)).length, 2);

  // A log, then a question typed indented on the next line: the question stays outside the span.
  const ASK = '    why does worker-3 keep timing out here? please check';
  const T8 = newT();
  const p8 = prompt(T8, `${LOGTXT}\n${ASK}`);
  check('Cp8-indented-question-kept', p8.decision === 'rewritten' && p8.text.endsWith(`original_result>>\n${ASK}`) && p8.spans.length === 1 && p8.spans[0].kind === 'log', String(p8.text).slice(-300));

  // A run killed at its timeout leaves a journal; once it is stale the next run removes what it lists,
  // except a file a later prompt reused (re-dated) and anything outside the prompt dir.
  const T9 = newT();
  prompt(T9, HEAD + ISSUES + TAIL);
  const d9 = dirOf(T9);
  const orphan = path.join(d9, 'slim-prompt-aaaaaaaaaaaaaaaa.json');
  const reused = path.join(d9, 'slim-prompt-bbbbbbbbbbbbbbbb.json');
  const fresh = path.join(d9, 'slim-prompt-cccccccccccccccc.txt');
  const outside = path.join(T9, 'slim-prompt-dddddddddddddddd.json');
  for (const f of [orphan, reused, fresh, outside]) writeFileSync(f, 'synthetic');
  writeFileSync(path.join(d9, '.pending-1-stale'), `${orphan}\n${reused}\n${outside}\n`);
  writeFileSync(path.join(d9, '.pending-2-fresh'), `${fresh}\n`);
  const hourAgo = new Date(Date.now() - 3600 * 1000);
  const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000);
  utimesSync(orphan, twoHoursAgo, twoHoursAgo);
  utimesSync(path.join(d9, '.pending-1-stale'), hourAgo, hourAgo);
  prompt(T9, `${HEAD}${WIDE}${TAIL}`);
  eq('Cp9-stale-journal-swept', [existsSync(orphan), existsSync(reused), existsSync(fresh), existsSync(outside), files(T9).filter((f) => f.startsWith('.pending-'))],
    [false, true, true, true, ['.pending-2-fresh']]);

  // --prompt-drop: a rewrite the session never took; only that root's prompt spills go.
  const T10 = newT();
  const p10 = prompt(T10, HEAD + ISSUES + TAIL);
  const keep10 = path.join(T10, 'slim-prompt-eeeeeeeeeeeeeeee.json');
  writeFileSync(keep10, 'synthetic');
  const dr = spawn(T10, JSON.stringify({ v: 1, root: T10, files: [...(p10.created || []), keep10, '../x'] }), { args: ['--prompt-drop'] });
  check('Cp10-drop', dr.status === 0 && dr.stdout === '' && (p10.created || []).length === 2 && !(p10.created || []).some((f) => existsSync(f)) && existsSync(keep10),
    `exit ${dr.status} ${JSON.stringify(p10.created)}`);

  // Worktree: the spill lands in the main checkout, which outlives the linked tree.
  const T4 = newT();
  const main = path.join(T4, 'main');
  const wt = path.join(T4, 'wt');
  mkdirSync(path.join(main, '.git/worktrees/x'), { recursive: true });
  mkdirSync(wt, { recursive: true });
  writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(main, '.git/worktrees/x')}\n`);
  const p4 = prompt(T4, HEAD + ISSUES + TAIL, wt);
  check('Cp4-worktree', p4.decision === 'rewritten' && files(main).length > 0 && !existsSync(dirOf(wt)), JSON.stringify(files(main)));

  // Left as typed: a small prompt, prose only, an already-slim span, a linked folder in the dir path.
  const T5 = newT();
  eq('Cp5-small', [prompt(T5, 'short').reason, existsSync(dirOf(T5))], ['size-gate', false]);
  eq('Cp5-prose', prompt(T5, 'plain words and nothing else. '.repeat(600)).reason, 'no-span');
  const slimmed = `${LOGTXT}\n\nslim: compressed 40,000 B → 900 B (−97.8%)\n\n<<full=/x/.claude/slim/prompt/slim-prompt-0123456789abcdef.txt original_result>>\nok?`;
  const fndSlimmed = `${HEAD}${ISSUES.replace('"total": 400', '"total": 400, "note": "fnd-prompt-json-1.json"')}${TAIL}`;
  eq('Cp5-already-slim', [prompt(T5, slimmed).reason, prompt(T5, fndSlimmed).reason, existsSync(dirOf(T5))], ['no-span', 'no-span', false]);
  const T6 = newT();
  mkdirSync(path.join(T6, '.claude'), { recursive: true });
  mkdirSync(path.join(T6, 'elsewhere'), { recursive: true });
  symlinkSync(path.join(T6, 'elsewhere'), path.join(T6, '.claude/slim'));
  eq('Cp6-link-refused', [prompt(T6, HEAD + ISSUES + TAIL).reason, readdirSync(path.join(T6, 'elsewhere')).length], ['spill-dir-refused', 0]);

  // The spill root's sweep never reaches the prompt dir.
  const old48 = new Date(Date.now() - 48 * 3600 * 1000);
  utimesSync(h1[1], old48, old48);
  call('Cp7-sweep', T, envelope(T, F1), { SLIM_DIR: dirOf(T), SLIM_TTL: '1' });
  check('Cp7-prompt-spill-kept', existsSync(h1[1]), h1[1]);

  // Cx — --access: one line per spill file that exists, levels 1 and 2 only; --report pairs it.
  const T7 = newT();
  const spillDir = path.join(T7, 'spill');
  mkdirSync(spillDir, { recursive: true });
  const sp = path.join(spillDir, 'fnd-mcp-slim-0123456789abcdef.json');
  writeFileSync(sp, F1);
  const access = (payload, extra) => spawn(T7, JSON.stringify({ v: 1, cwd: T7, ...payload }), { args: ['--access'], extra });
  const ax = access({ tool: 'Bash', via: 'jq', spills: [sp, sp, path.join(spillDir, 'fnd-mcp-slim-ffffffffffffffff.json')] });
  check('Cx1-exit', ax.status === 0 && ax.stdout === '', `exit ${ax.status}`);
  access({ tool: 'Read', via: 'Read', spills: [sp] }, { SLIM_DEBUG: '1' });
  access({ tool: 'Grep', via: 'Grep', spills: [sp] }, { SLIM_DEBUG: undefined });
  access({ tool: 'Edit', via: 'x', spills: [sp] });
  eq('Cx1-lines', logLines(spillDir).map((l) => [l.src, l.channel, l.entry, l.tool, l.via, l.spill, l.lvl]),
    [['slim', 'bash', 'access', 'Bash', 'jq', sp, 2], ['slim', 'read', 'access', 'Read', 'Read', sp, 1]]);
  const rlog = path.join(T7, 'pair.log');
  const ts = (s) => `2026-10-08T10:00:0${s}.000Z`;
  writeFileSync(rlog, [
    { ts: ts(0), lvl: 1, src: 'slim', channel: 'mcp', entry: 'hook', tool: 'mcp__x__y', decision: 'passthrough', reason: 'platform-overflow', bytes_in: 300, bytes_out: 300, spill: sp },
    { ts: ts(1), lvl: 1, src: 'slim', channel: 'bash', entry: 'access', tool: 'Bash', via: 'jq', spill: sp },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n');
  const rp = spawn(T7, '', { args: ['--report', rlog] });
  check('Cx2-report-pairs', /missed whales \(platform-overflow never read by any tool\): 0 of 1/.test(rp.stdout) && /spill reads \(access hook\): 1 {2}\(via: jq 1\)/.test(rp.stdout), rp.stdout);

  // A read the guard denied: marked, counted on its own, never a recovery.
  const T8x = newT();
  const spill8 = path.join(T8x, 'spill');
  mkdirSync(spill8, { recursive: true });
  const sp8 = path.join(spill8, 'fnd-mcp-slim-0123456789abcdef.json');
  writeFileSync(sp8, F1);
  spawn(T8x, JSON.stringify({ v: 1, cwd: T8x, tool: 'Read', via: 'Read', spills: [sp8], denied: true }), { args: ['--access'] });
  eq('Cx3-denied-line', logLines(spill8).map((l) => [l.entry, l.tool, l.denied]), [['access', 'Read', true]]);
  writeFileSync(rlog, [
    { ts: ts(0), lvl: 1, src: 'slim', channel: 'mcp', entry: 'hook', tool: 'mcp__x__y', decision: 'passthrough', reason: 'platform-overflow', bytes_in: 300, bytes_out: 300, spill: sp },
    { ts: ts(1), lvl: 1, src: 'slim', channel: 'read', entry: 'access', tool: 'Read', via: 'Read', spill: sp, denied: true },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n');
  const rd = spawn(T7, '', { args: ['--report', rlog] });
  check('Cx3-denied-not-a-recovery', /missed whales \(platform-overflow never read by any tool\): 1 of 1/.test(rd.stdout)
    && /spill reads \(access hook\): 0 {2}\(via: none\) · denied by the spill-read guard: 1/.test(rd.stdout), rd.stdout);

  // fnd's PreToolUse hook and slim's guard both logged one read: counted once.
  writeFileSync(rlog, [
    { ts: ts(0), lvl: 1, src: 'slim', channel: 'mcp', entry: 'hook', tool: 'mcp__x__y', decision: 'passthrough', reason: 'platform-overflow', bytes_in: 300, bytes_out: 300, spill: sp },
    { ts: ts(1), project: 'p', lvl: 1, entry: 'access', tool: 'Bash', via: 'jq', spill: sp },
    { ts: ts(2), lvl: 1, src: 'slim', channel: 'bash', entry: 'access', tool: 'Bash', via: 'jq', spill: sp },
    { ts: '2026-10-08T10:05:00.000Z', lvl: 1, src: 'slim', channel: 'bash', entry: 'access', tool: 'Bash', via: 'jq', spill: sp },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n');
  const rt = spawn(T7, '', { args: ['--report', rlog] });
  check('Cx4-twins-once', /spill reads \(access hook\): 2 {2}\(via: jq 2\) \[\+1 logged by both fnd and slim\]/.test(rt.stdout), rt.stdout);
}

// --report groups the channels written above.
{
  const T = newT();
  call('Rp-mcp', T, envelope(T, F1));
  call('Rp-bash', T, chEnv(T, 'bash', 'Bash', { command: 'curl -s https://x.example/a' }, BASH(F1)));
  call('Rp-web', T, chEnv(T, 'webfetch', 'WebFetch', { url: 'https://shop.example/p' }, { bytes: 1, code: 200, codeText: 'OK', result: PAGE, durationMs: 1, url: 'https://shop.example/p' }));
  const r = spawn(T, '', { args: ['--report'] });
  check('Rp-by-channel', /^ {2}by channel: bash \d+ → \d+ B \([\d.]+% saved\) · mcp \d+ → \d+ B \([\d.]+% saved\) · webfetch \d+ → \d+ B \([\d.]+% saved\)$/m.test(r.stdout), r.stdout);
  check('Rp-by-src', /^ {2}by src: slim \d+ → \d+ B/m.test(r.stdout), r.stdout);
}
// A summary of a persisted Bash output outgrows the host's preview: worded as a grown view, never as a negative saving.
{
  const T = newT();
  const log = path.join(T, 'r.log');
  const line = (o) => JSON.stringify({ ts: '2026-10-07T10:00:00.000Z', lvl: 2, src: 'slim', entry: 'hook', ...o });
  writeFileSync(log, `${[
    line({ channel: 'bash', decision: 'compressed', bytes_in: 300000, bytes_seen: 2300, bytes_out: 7000 }),
    line({ channel: 'bash', decision: 'compressed', bytes_in: 260779, bytes_seen: 2346, bytes_out: 7935 }),
    line({ channel: 'mcp', decision: 'compressed', bytes_in: 10000, bytes_out: 2500 }),
    line({ channel: 'read', decision: 'compressed', bytes_in: 90000, bytes_seen: 90000, bytes_out: 30000 }),
    line({ src: 'fnd', channel: 'mcp', decision: 'passthrough', reason: 'size-gate', bytes_in: 800, bytes_out: 800 }),
  ].join('\n')}\n`);
  const r = spawn(T, '', { args: ['--report', log] });
  const byChannel = (/^ {2}by channel: (.*)$/m.exec(r.stdout) || [])[1];
  eq('Rg-by-channel', byChannel, 'bash: 2 results, 560,779 B of output summarised into 14,935 B (host preview would have shown 4,646 B; the view grew ×3.2)'
    + ' · mcp 10800 → 3300 B (69.4% saved) · read 90000 → 30000 B (66.7% saved)');
  const bySrc = (/^ {2}by src: (.*)$/m.exec(r.stdout) || [])[1];
  eq('Rg-by-src', bySrc, 'fnd 800 → 800 B (0.0% saved) · slim 104646 → 47435 B (54.7% saved)');
  check('Rg-no-negative', !/-\d[\d.]*% saved/.test(r.stdout), r.stdout);
  writeFileSync(log, `${line({ channel: 'bash', decision: 'compressed', bytes_in: 300000, bytes_seen: 2300, bytes_out: 7000 })}\n`);
  const one = spawn(T, '', { args: ['--report', log] });
  check('Rg-one-result', /^ {2}by src: slim: 1 result, 300,000 B of output summarised into 7,000 B \(host preview would have shown 2,300 B; the view grew ×3\.0\)$/m.test(one.stdout), one.stdout);
  // Under ×1.1 the growth is given in bytes; a passthrough is counted apart, never as summarised output.
  writeFileSync(log, `${[
    line({ channel: 'bash', decision: 'compressed', bytes_in: 300000, bytes_seen: 2048, bytes_out: 2100 }),
    line({ channel: 'bash', decision: 'passthrough', reason: 'size-gate', bytes_in: 500, bytes_out: 500 }),
  ].join('\n')}\n`);
  const small = spawn(T, '', { args: ['--report', log] });
  eq('Rg-small-growth', (/^ {2}by channel: (.*)$/m.exec(small.stdout) || [])[1],
    'bash: 1 result, 300,000 B of output summarised into 2,100 B (host preview would have shown 2,048 B; the view grew by 52 B) + 1 passed through (500 B)');
}

// Cm — the media backend (delivery/media.cjs) with fake ffprobe / ffmpeg / sips: each row's PATH is
// one fake bin dir only, so a real ffmpeg or macOS sips never runs. The fakes use shell builtins only.
{
  const require = createRequire(import.meta.url);
  const dm = require(path.join(SCRIPTS, 'delivery/media.cjs'));
  const T = newT();
  const bin = (dir, files) => {
    mkdirSync(dir, { recursive: true });
    for (const [n, body] of Object.entries(files)) writeFileSync(path.join(dir, n), `#!/bin/sh\n${body}`, { mode: 0o755 });
    return dir;
  };
  const FFPROBE = `for a; do f=$a; done
printf '%s\\n' "$*" > "$FAKE_LOG.probe"
case "$f" in
  *broken*) exit 1 ;;
  *hang*) while :; do :; done ;;
  *portrait*.mp4) printf '{"frames":[{"side_data_list":[{"rotation":-90},{}]}],"streams":[{"width":1920,"height":1080,"duration":"7.0"}],"format":{"duration":"7.000000"}}\\n' ;;
  *turned*.mp4) printf '{"streams":[{"width":1920,"height":1080,"side_data_list":[{"rotation":90}]}],"format":{"duration":"7.000000"}}\\n' ;;
  *.mp4) printf '{"streams":[{"width":1920,"height":1080,"duration":"7.0"}],"format":{"duration":"7.000000"}}\\n' ;;
  *portrait*) printf '{"frames":[{"side_data_list":[{"rotation":-90}]}],"streams":[{"width":4000,"height":3000}],"format":{}}\\n' ;;
  *) printf '{"streams":[{"width":4000,"height":3000}],"format":{}}\\n' ;;
esac
`;
  const FFMPEG = `n=1; prev=; for a; do [ "$prev" = "-frames:v" ] && n=$a; prev=$a; out=$a; done
printf '%s\\n' "$*" >> "$FAKE_LOG"
[ -n "$FAKE_FAIL" ] && { printf 'fake failure\\n' >&2; exit 1; }
case "$out" in
  *%03d*) i=1; while [ $i -le $n ]; do printf 'FRAME' > "$(printf "$out" $i)"; [ -n "$FAKE_HANG" ] && while :; do :; done; i=$((i+1)); done ;;
  *) printf 'IMG' > "$out" ;;
esac
`;
  const SIPS = `for a; do last=$a; done
[ "$1" = "-g" ] && { printf '%s\\n  pixelWidth: 3000\\n  pixelHeight: 2000\\n' "$last"; exit 0; }
printf '%s\\n' "$*" >> "$FAKE_LOG"
printf 'SIPSIMG' > "$last"
`;
  const FF = bin(path.join(T, 'ff'), { ffprobe: FFPROBE, ffmpeg: FFMPEG });
  const SB = bin(path.join(T, 'sb'), { sips: SIPS });
  const LOGF = path.join(T, 'argv.log');
  const argv = () => (existsSync(LOGF) ? readFileSync(LOGF, 'utf8') : '');
  const at = (rel) => path.join(T, rel);
  const media = (name, bytes) => { const p = at(name); writeFileSync(p, bytes); return p; };
  const PNG_IN = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(4992, 1)]);
  const JPG_IN = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1]), Buffer.alloc(996, 3)]);
  const WEBP_IN = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.alloc(4, 1), Buffer.from('WEBPVP8 ', 'latin1'), Buffer.alloc(988, 4)]);
  const MP4_IN = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypisom', 'latin1'), Buffer.alloc(19988, 2)]);
  const run = (file, PATH, out, extra = {}) => {
    rmSync(LOGF, { force: true });
    return dm.normalize(file, { allowedOut: out && at(out), env: { PATH, FAKE_LOG: LOGF, ...extra.env }, ...extra.opts });
  };
  const ls = (rel) => readdirSync(at(rel)).sort();

  const png = media('photo.png', PNG_IN);
  const r1 = run(png, FF, 'photo.1568.png');
  eq('Cm-image-ffmpeg', [r1.decision, r1.figure, r1.frames, r1.backend, r1.outputs.map((o) => path.basename(o.path)), readFileSync(at('photo.1568.png'), 'utf8')],
    ['compressed', 'media: 5000 B → 3 B (-100%) frames=1', 1, 'ffmpeg', ['photo.1568.png'], 'IMG']);
  check('Cm-image-ffmpeg-argv', /-map_metadata -1 -vf scale=1568:1568:force_original_aspect_ratio=decrease -frames:v 1 .*photo\.1568\.png$/m.test(argv()) && r1.text.startsWith('image png 4000×3000 → 1568×1176, metadata stripped (ffmpeg)\n'), argv() + r1.text);
  check('Cm-probe-argv', readFileSync(`${LOGF}.probe`, 'utf8').startsWith('-v error -select_streams v:0 -read_intervals %+#1 -show_entries stream=width,height,duration:stream_side_data=rotation:frame_side_data=rotation:format=duration -of json '),
    readFileSync(`${LOGF}.probe`, 'utf8'));

  const mp4 = media('clip.mp4', MP4_IN);
  mkdirSync(at('clip.frames'));
  writeFileSync(at('clip.frames/.slim-frames'), '');
  writeFileSync(at('clip.frames/009.jpg'), 'STALE');
  writeFileSync(at('clip.frames/keep.txt'), 'NOT OURS');
  const r2 = run(mp4, FF, 'clip.frames/001.jpg');
  eq('Cm-video-frames', [r2.decision, r2.figure, ls('clip.frames'), r2.outputs.map((o) => o.t)],
    ['compressed', 'media: 20000 B → 20 B (-100%) frames=4', ['.slim-frames', '001.jpg', '002.jpg', '003.jpg', '004.jpg', 'keep.txt'], [0, 2, 4, 6]]);
  check('Cm-video-argv', /-vf fps=1\/2,scale=1568:1568:force_original_aspect_ratio=decrease -frames:v 4 -q:v 4 .*clip\.frames\/%03d\.jpg$/m.test(argv()) && r2.text.includes(`${at('clip.frames/004.jpg')}  t=6s`), argv() + r2.text);
  const r2s = run(mp4, FF, 'clip.frames/001.jpg', { opts: { scene: true } });
  check('Cm-video-scene', r2s.frames === 24 && /-vf select='eq\(n,0\)\+gt\(scene,0\.3\)',scale=1568:1568:force_original_aspect_ratio=decrease -fps_mode vfr -frames:v 24/.test(argv()) && !r2s.text.includes('t='), argv());
  const r2n = run(media('fresh.mp4', MP4_IN), FF, 'fresh.frames/001.jpg');
  eq('Cm-video-fresh-dir-marked', [r2n.frames, ls('fresh.frames')], [4, ['.slim-frames', '001.jpg', '002.jpg', '003.jpg', '004.jpg']]);

  mkdirSync(at('user.frames'));
  writeFileSync(at('user.frames/001.jpg'), 'MINE');
  const r2u = run(media('user.mp4', MP4_IN), FF, 'user.frames/001.jpg');
  eq('Cm-video-foreign-dir', [r2u.decision, r2u.reason, r2u.figure, ls('user.frames'), readFileSync(at('user.frames/001.jpg'), 'utf8'), argv()],
    ['refused', 'out-taken', `media: ${at('user.frames')} holds files slim did not write`, ['001.jpg'], 'MINE', '']);
  mkdirSync(at('elsewhere'));
  writeFileSync(at('elsewhere/001.jpg'), 'MINE');
  writeFileSync(at('elsewhere/.slim-frames'), '');
  symlinkSync(at('elsewhere'), at('linked.frames'));
  const r2l = run(media('linked.mp4', MP4_IN), FF, 'linked.frames/001.jpg');
  eq('Cm-video-linked-dir', [r2l.reason, ls('elsewhere'), readFileSync(at('elsewhere/001.jpg'), 'utf8'), argv()], ['out-taken', ['.slim-frames', '001.jpg'], 'MINE', '']);
  mkdirSync(at('empty.frames'));
  eq('Cm-video-empty-dir', [run(media('empty.mp4', MP4_IN), FF, 'empty.frames/001.jpg').frames, ls('empty.frames').length], [4, 5]);

  const r2p = run(media('portrait.mp4', MP4_IN), FF, 'portrait.frames/001.jpg');
  check('Cm-video-rotated-frame-side-data', r2p.text.startsWith('video mp4 7s 1080×1920 → frames every 2s at 882×1568 (ffmpeg)\n') && argv().includes('scale=1568:1568:force_original_aspect_ratio=decrease') && !argv().includes('1568:882'), argv() + r2p.text);
  const r2t = run(media('turned.mp4', MP4_IN), FF, 'turned.frames/001.jpg');
  check('Cm-video-rotated-stream-side-data', r2t.text.startsWith('video mp4 7s 1080×1920 → frames every 2s at 882×1568 (ffmpeg)\n'), r2t.text);
  const r1p = run(media('portrait.jpg', JPG_IN), FF, 'portrait.1568.jpg');
  check('Cm-image-exif-rotated', r1p.text.startsWith('image jpeg 3000×4000 → 1176×1568, metadata stripped (ffmpeg)\n') && /-vf scale=1568:1568:force_original_aspect_ratio=decrease -frames:v 1 -q:v 3 /.test(argv()), argv() + r1p.text);

  const r3 = run(media('fail.mp4', MP4_IN), FF, 'fail.frames/001.jpg', { env: { FAKE_FAIL: '1' } });
  eq('Cm-backend-failed', [r3.decision, r3.reason, r3.figure, existsSync(at('fail.frames'))],
    ['refused', 'backend-failed', 'media: ffmpeg failed on fail.mp4: fake failure', false]);
  const r3b = run(media('broken.png', PNG_IN), FF, 'broken.1568.png');
  eq('Cm-probe-failed', [r3b.reason, existsSync(at('broken.1568.png')), argv()], ['no-probe', false, '']);

  let t0 = Date.now();
  const r3h = run(media('hang.mp4', MP4_IN), FF, 'hang.frames/001.jpg', { opts: { timeoutMs: 400 } });
  const probeMs = Date.now() - t0;
  eq('Cm-deadline-bounds-probe', [r3h.reason, probeMs < 5000, existsSync(at('hang.frames')), argv()], ['no-probe', true, false, '']);
  t0 = Date.now();
  const r3r = run(media('slow.mp4', MP4_IN), FF, 'slow.frames/001.jpg', { env: { FAKE_HANG: '1' }, opts: { timeoutMs: 600 } });
  const runMs = Date.now() - t0;
  eq('Cm-deadline-bounds-run', [r3r.decision, r3r.reason, runMs < 5000, existsSync(at('slow.frames'))], ['refused', 'backend-failed', true, false]);

  const r4 = run(media('shot.png', PNG_IN), SB, 'shot.1568.png');
  eq('Cm-sips-image', [r4.decision, r4.backend, readFileSync(at('shot.1568.png'), 'utf8'), argv().trim()],
    ['compressed', 'sips', 'SIPSIMG', `-s format png -Z 1568 ${at('shot.png')} --out ${at('shot.1568.png')}`]);
  check('Cm-sips-metadata-honest', r4.text.includes('metadata kept (sips cannot strip it) (sips)'), r4.text);
  const r5 = run(media('sipsclip.mp4', MP4_IN), SB, 'sipsclip.frames/001.jpg');
  eq('Cm-sips-video', [r5.decision, r5.reason, r5.figure, existsSync(at('sipsclip.frames'))], ['refused', 'no-backend', 'media: no backend (install ffmpeg)', false]);
  eq('Cm-no-backend', [run(png, '', 'photo.1568.png').figure, run(png, at('nowhere'), 'photo.1568.png').reason, run(png, `${at('ff')}/ffmpeg`, 'photo.1568.png').reason],
    ['media: no backend (install ffmpeg)', 'no-backend', 'no-backend']);

  const r7 = run(media('web.jpg', WEBP_IN), FF, 'web.1568.jpg');
  eq('Cm-name-from-ext-webp-as-jpg', [r7.decision, r7.format, r7.outputs.map((o) => path.basename(o.path)), existsSync(at('web.1568.png'))], ['compressed', 'webp', ['web.1568.jpg'], false]);
  const r7b = run(media('pic.jpg', WEBP_IN), FF, 'pic.1568.png');
  eq('Cm-name-mismatch-denied', [r7b.reason, r7b.figure, existsSync(at('pic.1568.png')), existsSync(at('pic.1568.jpg')), argv()],
    ['write-denied', `media: writing ${at('pic.1568.jpg')} is not permitted`, false, false, '']);
  const r7c = run(media('screenshot', PNG_IN), FF, 'screenshot.1568.png');
  eq('Cm-name-no-ext', [r7c.decision, r7c.outputs.map((o) => path.basename(o.path))], ['compressed', ['screenshot.1568.png']]);
  const r7d = run(media('clip.png', MP4_IN), FF, 'clip.1568.png');
  eq('Cm-name-kind-mismatch', [r7d.kind, r7d.reason, existsSync(at('clip.1568.png')), argv()], ['video', 'write-denied', false, '']);
  rmSync(at('photo.1568.png'));
  const r7e = run(png, FF, 'photo.1568.png', { opts: { longEdge: 800 } });
  eq('Cm-long-edge-mismatch', [r7e.reason, existsSync(at('photo.800.png')), existsSync(at('photo.1568.png'))], ['write-denied', false, false]);
  symlinkSync(at('elsewhere/001.jpg'), at('linked.1568.png'));
  const r7f = run(media('linked.png', PNG_IN), FF, 'linked.1568.png');
  writeFileSync(at('dir.png'), PNG_IN);
  mkdirSync(at('dir.1568.png'));
  eq('Cm-image-out-taken', [r7f.reason, readFileSync(at('elsewhere/001.jpg'), 'utf8'), run(at('dir.png'), FF, 'dir.1568.png').reason, argv()], ['out-taken', 'MINE', 'out-taken', '']);

  const r6 = dm.normalize(png, { env: { PATH: FF, FAKE_LOG: LOGF } });
  eq('Cm-write-not-ok', [r6.decision, r6.reason, existsSync(at('photo.1568.png')), r6.outputs], ['refused', 'write-denied', false, []]);
  eq('Cm-not-media', [run(media('notes.txt', 'plain text'), FF, 'x').reason, run(media('pic.heic', Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic', 'latin1'), Buffer.alloc(64)])), FF, 'x').reason,
    run(media('empty.png', ''), FF, 'x').reason, run(at('missing.png'), FF, 'x').reason], ['not-media', 'not-media', 'unreadable', 'unreadable']);
}

// Cv — the view tool's core (--view): a file, a command's output or its host file → compact text, jq
// narrowing first, `out` handed back as a write with its cache marker, media through the backend.
{
  const T = newT();
  const proj = path.join(T, 'proj');
  const tasks = path.join(proj, '.claude/tasks/T1');
  mkdirSync(tasks, { recursive: true });
  const ISSUES = JSON.stringify({ total: 400, issues: Array.from({ length: 400 }, (_, i) => ({ key: `ACME-${i}`, id: String(10000 + i), fields: { summary: `Summary number ${i} ${'x'.repeat(40)}`, status: { name: i % 3 ? 'Open' : 'Done' }, labels: ['a', 'b'] } })) });
  const src = path.join(proj, 'issues.json');
  writeFileSync(src, ISSUES);
  old(src);
  const view = (name, req, extra) => {
    const r = spawn(T, JSON.stringify({ v: 1, root: proj, cwd: proj, session_id: 's1', ...req }), { args: ['--view'], extra });
    check(`${name}-exit`, r.status === 0 && r.stderr === '', `exit ${r.status} ${r.stderr}`);
    try { return JSON.parse(r.stdout); } catch (_) { return { decision: 'unparsed', text: r.stdout }; }
  };
  const spillDir = path.join(T, 'spill');

  const v1 = view('Cv1', { path: src });
  eq('Cv1-json', [v1.v, v1.decision, v1.engine, v1.bytesIn, v1.pointer], [1, 'compressed', 'json', bytes(ISSUES), undefined]);
  check('Cv1-figure', /^slim: compressed 63,\d{3} B → [\d,]+ B \(−\d+\.\d%\)$/.test(v1.figure) && v1.bytesOut === bytes(v1.text) && v1.bytesOut <= 16384, v1.figure);
  const part = (/<<full=(\S+) \d+_rows_offloaded>>/.exec(v1.text) || [])[1];
  check('Cv1-part-written', !!part && part.startsWith(`${spillDir}/fnd-crush-`) && existsSync(part), String(part));

  const nodes = path.join(proj, 'K1-1-2.nodes.json');
  writeFileSync(nodes, REST);
  const v2a = view('Cv2a', { path: nodes });
  copyFileSync(path.join(FIX, 'figma-variables-local.json'), path.join(proj, 'K1.variables.json'));
  const v2 = view('Cv2', { path: nodes });
  eq('Cv2-figma-nodes', [v2.decision, v2.engine], ['compressed', 'figma-nodes']);
  check('Cv2-figure', /^figma-nodes: 192234 B → \d+ B \(-\d+\.\d%\) nodes=\d+ hidden=\d+ folded=\d+$/.test(v2.figure), v2.figure);
  check('Cv2-variables-beside', v2.text.includes('tokens: variables') && !v2a.text.includes('tokens: variables'), 'K1.variables.json not read');
  check('Cv2-pointer', typeof v2.pointer === 'string' && v2.pointer.startsWith(`${spillDir}/fnd-mcp-slim-`) && readFileSync(v2.pointer, 'utf8') === v2.text, String(v2.pointer));

  const v3 = view('Cv3', { path: src, jq: '.issues[].key' });
  eq('Cv3-narrowed', [v3.decision, v3.narrowed, v3.engine, JSON.parse(v3.text).length, JSON.parse(v3.text)[399]], ['narrowed', true, 'json', 400, 'ACME-399']);
  check('Cv3-figure', v3.figure === `slim view: narrowed by jq to ${bytes(v3.text).toLocaleString('en-US')} B of a ${bytes(ISSUES).toLocaleString('en-US')} B source (no saving figure: jq changed the measured object)`, v3.figure);
  const v3b = view('Cv3b', { path: src, jq: '.issues' });
  check('Cv3b-big-narrowed-compressed', v3b.decision === 'narrowed' && v3b.figure.includes(', compressed to ') && v3b.bytesOut <= 16384, v3b.figure);
  eq('Cv3c-refusals', [view('Cv3c', { path: src, jq: '.issues[] | select(.id)' }).reason, view('Cv3d', { path: src, jq: '.nope' }).reason, view('Cv3e', { path: path.join(FIX, 'app.log'), jq: '.a' }).reason],
    ['jq-unsupported', 'jq-miss', 'jq-not-json']);
  eq('Cv3f-whole-is-no-narrowing', view('Cv3f', { path: src, jq: '.' }).decision, 'compressed');
  // A big narrowed value the engine cannot shrink is kept in the spill root, never pointed at the source.
  writeFileSync(path.join(proj, 'blob.json'), JSON.stringify({ blob: 'word '.repeat(8000), n: 1 }));
  const v3g = view('Cv3g', { path: 'blob.json', jq: '.blob' });
  check('Cv3g-relative-path-and-pointer', v3g.decision === 'narrowed' && typeof v3g.pointer === 'string' && v3g.pointer.startsWith(`${spillDir}/fnd-mcp-slim-`)
    && readFileSync(v3g.pointer, 'utf8') === v3g.text && JSON.parse(v3g.text).length === 40000, JSON.stringify({ ...v3g, text: undefined }));

  const out = path.join(tasks, 'issues.view.json');
  const v4 = view('Cv4', { path: src, out });
  const marker = /^<<slim view k=[0-9a-f]{12} engine=json v=[\w.+-]+>>$/;
  // Uniform rows give the json engine nothing to crush, and with out the fit target is 64 KB: a 63 KB source stays whole.
  eq('Cv4-write', [v4.decision, v4.out, v4.pointer, v4.write && v4.write.path, v4.write && v4.write.exists, existsSync(out)], ['passthrough', out, out, out, false, false]);
  // The text travels once: the mod writes the marker line, then the text.
  const content4 = v4.write ? `${v4.write.marker}\n${v4.text}` : '';
  check('Cv4-content', !!v4.write && marker.test(v4.write.marker) && v4.write.content === undefined && v4.lines === content4.split('\n').length, v4.write && v4.write.marker);
  check('Cv4-out-not-fitted', v4.bytesOut > 16384, `${v4.bytesOut}`);
  writeFileSync(out, content4);
  const v5 = view('Cv5', { path: src, out });
  eq('Cv5-cached', [v5.decision, v5.figure, v5.engine, v5.text === v4.text, v5.out, v5.write, v5.lines], ['cached', 'cached', 'json', true, out, undefined, v4.lines]);
  eq('Cv5-other-jq-recomputes', view('Cv5b', { path: src, out, jq: '.total' }).decision, 'narrowed');
  const later = new Date(Date.now() + 60_000);
  utimesSync(src, later, later);
  const v6 = view('Cv6', { path: src, out });
  eq('Cv6-input-newer-recomputes', [v6.decision, v6.write && v6.write.exists], ['passthrough', true]);
  old(src);
  writeFileSync(out, `<<slim view k=000000000000 engine=json v=0.0.0>>\n{}`);
  eq('Cv6b-foreign-marker-recomputes', view('Cv6b', { path: src, out }).decision, 'passthrough');

  mkdirSync(path.join(tasks, 'adir'));
  eq('Cv7-out-refusals', [
    view('Cv7a', { path: src, out: path.join(T, 'elsewhere.json') }).reason,
    view('Cv7b', { path: src, out: path.join(proj, '.claude/tasks/top.json') }).reason,
    view('Cv7c', { path: src, out: path.join(tasks, 'adir') }).reason,
    view('Cv7d', { path: src, out: path.join(tasks, '..', '..', '..', 'issues.view.json') }).reason,
  ], ['out-outside-roots', 'out-outside-roots', 'out-taken', 'out-outside-roots']);
  const vs = view('Cv7e', { path: src, out: path.join(spillDir, 'mine.json') });
  eq('Cv7e-spill-root-ok', [vs.decision, vs.write && vs.write.path], ['passthrough', path.join(spillDir, 'mine.json')]);
  const vr = view('Cv7f', { path: src, out: 'issues.rel.json', cwd: tasks });
  eq('Cv7f-relative-to-cwd', vr.write && vr.write.path, path.join(tasks, 'issues.rel.json'));
  // The OUTPUT_CAP (4 MiB less headroom) measures the text once, out or not.
  const words = (n) => JSON.stringify({ ids: Array.from({ length: n }, (_, i) => `w${i.toString(36).padStart(4, '0')}${'z'.repeat(i % 50)}`).join(' ') });
  writeFileSync(path.join(proj, 'wide.json'), words(80_000));
  const vw = view('Cv7g', { path: path.join(proj, 'wide.json'), out: path.join(tasks, 'wide.view.json') });
  check('Cv7g-out-2-to-4-MiB-fits', vw.decision === 'passthrough' && vw.bytesOut > 2_200_000 && vw.bytesOut < 4_000_000 && !!vw.write, JSON.stringify({ ...vw, text: undefined }));
  writeFileSync(path.join(proj, 'huge.json'), words(140_000));
  const vh = view('Cv7h', { path: path.join(proj, 'huge.json'), out: path.join(tasks, 'huge.view.json') });
  eq('Cv7h-out-over-cap', [vh.decision, vh.reason, vh.text], ['refused', 'output-cap', 'view: the compact text is over 4 MiB even for out — narrow with jq, or Read the source windowed']);

  // A whale of unique rows is still fitted with out: the task file gets the compact text, never the source.
  const whale = JSON.stringify({ total: 8000, issues: Array.from({ length: 8000 }, (_, i) => ({ key: `ACME-${i}`, id: String(10000 + i), fields: { summary: `Summary number ${i} ${'x'.repeat(40)}`, status: { name: i % 3 ? 'Open' : 'Done' }, labels: ['a', 'b'] } })) });
  writeFileSync(path.join(proj, 'whale.json'), whale);
  const wo = path.join(tasks, 'whale.view.md');
  const vwh = view('Cv7w', { path: path.join(proj, 'whale.json'), out: wo });
  check('Cv7w-out-whale-fitted', bytes(whale) > 1_000_000 && vwh.decision === 'compressed' && !!vwh.write && vwh.write.path === wo
    && vwh.bytesOut <= 65536 && vwh.bytesOut === bytes(vwh.text) && /<<full=\S+ \d+_rows_offloaded>>/.test(vwh.text), JSON.stringify({ ...vwh, text: undefined }));

  const big = JSON.stringify(Array.from({ length: 600 }, (_, i) => ({ sku: `SKU-${i}`, qty: i % 7, note: 'y'.repeat(60) })));
  // An out cites its offloaded rows in the spill root: once the sweep took them, the cache recomputes.
  const exp = path.join(proj, 'export.json');
  writeFileSync(exp, big);
  old(exp);
  const xo = path.join(tasks, 'export.view.json');
  const x1 = view('Cv7i', { path: exp, out: xo });
  const xpart = (/<<full=(\S+) \d+_rows_offloaded>>/.exec(x1.text) || [])[1];
  check('Cv7i-out-cites-part', x1.decision === 'compressed' && !!xpart && existsSync(xpart) && !!x1.write, JSON.stringify({ ...x1, text: undefined }));
  writeFileSync(xo, `${x1.write.marker}\n${x1.text}`);
  eq('Cv7i-cached', view('Cv7j', { path: exp, out: xo }).decision, 'cached');
  rmSync(xpart);
  const x3 = view('Cv7k', { path: exp, out: xo });
  eq('Cv7k-part-gone-recomputes', [x3.decision, x3.write && x3.write.exists, existsSync(xpart)], ['compressed', true, true]);
  const v8 = view('Cv8', { text: big, command: 'cat export.json' });
  check('Cv8-command-original', v8.decision === 'compressed' && typeof v8.original === 'string' && readFileSync(v8.original, 'utf8') === big, JSON.stringify({ ...v8, text: undefined }));
  const host = hostFile(T, 'v1.txt', big);
  const v9 = view('Cv9', { host_path: host, command: 'cat export.json' }, { CLAUDE_CONFIG_DIR: `${T}/cfg` });
  eq('Cv9-host', [v9.decision, v9.original, v9.bytesIn], ['compressed', host, bytes(big)]);
  writeFileSync(path.join(T, 'x.txt'), big);
  eq('Cv9-forged-host', view('Cv9b', { host_path: path.join(T, 'x.txt') }).reason, 'expand-refused');

  const pdf = path.join(proj, 'doc.pdf');
  writeFileSync(pdf, `%PDF-1.7\n${'x'.repeat(100)}`);
  eq('Cv10-misc', [view('Cv10a', { path: pdf }).reason, view('Cv10b', { path: src, engine: 'zip' }).reason, view('Cv10c', { path: src, engine: 'media' }).reason,
    view('Cv10d', { path: path.join(proj, 'missing.json') }).reason, view('Cv10e', {}).reason], ['binary', 'bad-engine', 'not-media', 'expand-missing', 'bad-input']);
  const small = path.join(proj, 'small.json');
  writeFileSync(small, '{"a":1}');
  const v11 = view('Cv11', { path: small });
  eq('Cv11-small-as-is', [v11.decision, v11.text, v11.figure], ['passthrough', '{"a":1}', 'slim view: 7 B, not compressed (no-gain)']);

  // A view of a spill file is a recovery: one access line, as the old spill-access hook wrote.
  view('Cv12', { path: part });
  const access = logLines(spillDir).filter((l) => l.entry === 'access');
  eq('Cv12-access', access.map((l) => [l.src, l.channel, l.via, l.tool, l.spill]), [['slim', 'view', 'view', 'mcp__slim__view', part]]);

  const rec = spawn(T, JSON.stringify({ channel: 'view', tool_use_id: 'toolu_v', decision: 'narrowed', reason: null, rung: 'path', engine: 'json', bytes_in: 63004, bytes_out: 40, stages: [], spill: out, narrowed: true, ms: 12, cwd: proj }), { args: ['--record'], extra: { SLIM_DEBUG: undefined } });
  check('Cv13-record-exit', rec.status === 0 && rec.stdout === '', `exit ${rec.status}`);
  const row = logLines(spillDir).filter((l) => l.channel === 'view' && l.entry === 'mod');
  eq('Cv13-record-line', row.map((l) => [l.src, l.channel, l.tool, l.tool_use_id, l.decision, l.rung, l.engine, l.bytes_in, l.bytes_out, l.pct, l.spill, l.narrowed, l.lvl]),
    [['slim', 'view', 'mcp__slim__view', 'toolu_v', 'narrowed', 'path', 'json', 63004, 40, 0, out, true, 0]]);
  const rp = spawn(T, '', { args: ['--report'] });
  check('Cv13-report', /^ {2}by channel: view 63004 → 63004 B \(0\.0% saved\)$/m.test(rp.stdout) && /^ {2}passthrough reasons: jq-narrowed 1$/m.test(rp.stdout), rp.stdout);
  // A video's bytes never head for the context: its row keeps them apart from the savings totals.
  spawn(T, JSON.stringify({ channel: 'view', tool_use_id: 'toolu_m', decision: 'compressed', reason: null, rung: 'path', engine: 'media', bytes_in: 200_000_000, bytes_out: 3_000_000, stages: [], spill: null, frames: 24, ms: 900, cwd: proj }), { args: ['--record'], extra: { SLIM_DEBUG: undefined } });
  const mrow = logLines(spillDir).filter((l) => l.tool_use_id === 'toolu_m');
  eq('Cv13-media-row', mrow.map((l) => [l.engine, l.bytes_in, l.bytes_out, l.media_in, l.media_out, l.frames]), [['media', 0, 0, 200_000_000, 3_000_000, 24]]);
  const rp2 = spawn(T, '', { args: ['--report'] });
  const totals = (t) => (/^ {2}totals: .*$/m.exec(t) || [''])[0];
  check('Cv13-media-not-in-totals', totals(rp2.stdout) === totals(rp.stdout) && !rp2.stdout.includes('200000000') && /^ {2}by channel: view 63004 → 63004 B/m.test(rp2.stdout), rp2.stdout);

  // Media: the backend is a fake ffprobe/ffmpeg on a one-dir PATH; node is spawned by its own path.
  const fake = path.join(T, 'fakebin');
  mkdirSync(fake);
  writeFileSync(path.join(fake, 'ffprobe'), '#!/bin/sh\nprintf \'{"streams":[{"width":4000,"height":3000}],"format":{}}\\n\'\n', { mode: 0o755 });
  writeFileSync(path.join(fake, 'ffmpeg'), '#!/bin/sh\nfor a; do out=$a; done\nprintf IMG > "$out"\n', { mode: 0o755 });
  const media = path.join(T, 'media');
  mkdirSync(media);
  symlinkSync(media, path.join(T, 'linked'));
  writeFileSync(path.join(media, 'shot.png'), Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(992, 1)]));
  const viewMedia = (req, PATH) => {
    const r = spawnSync(process.execPath, [SLIM, '--view'], { cwd: T, env: envFor(T, { PATH }), input: JSON.stringify({ v: 1, root: proj, cwd: T, session_id: 's1', ...req }), encoding: 'utf8' });
    try { return JSON.parse(r.stdout); } catch (_) { return { decision: 'unparsed', text: r.stdout + r.stderr }; }
  };
  const viaLink = path.join(T, 'linked', 'shot.png');
  const m1 = viewMedia({ path: viaLink, allowed_out: path.join(T, 'linked', 'shot.1568.png') }, fake);
  eq('Cv14-image', [m1.decision, m1.engine, m1.figure, m1.frames, readFileSync(path.join(media, 'shot.1568.png'), 'utf8')], ['compressed', 'media', 'media: 1000 B → 3 B (-100%) frames=1', 1, 'IMG']);
  check('Cv14-text-lists-output', m1.text.endsWith(`\n${path.join(media, 'shot.1568.png')}`), m1.text);
  eq('Cv14-refusals', [
    viewMedia({ path: viaLink }, fake).reason,
    viewMedia({ path: viaLink, allowed_out: path.join(media, 'other.png') }, fake).reason,
    viewMedia({ path: viaLink, allowed_out: path.join(media, 'shot.1568.png') }, path.join(T, 'nobin')).figure,
    viewMedia({ path: viaLink, jq: '.a' }, fake).reason,
    viewMedia({ path: viaLink, out: path.join(tasks, 'x.md') }, fake).reason,
  ], ['write-denied', 'write-denied', 'media: no backend (install ffmpeg)', 'media-args', 'media-args']);
  // A media request whose bytes are text is refused, never read as text: no Read probe ruled on it.
  writeFileSync(path.join(T, 'creds'), 'SECRET=synthetic-value\n');
  writeFileSync(path.join(proj, 'notes.mp4'), 'SECRET=synthetic-value\n');
  symlinkSync(path.join(T, 'creds'), path.join(proj, 'demo.mp4'));
  const textAsMedia = [
    viewMedia({ path: path.join(proj, 'notes.mp4'), allowed_out: path.join(proj, 'notes.frames', '001.jpg') }, fake),
    viewMedia({ path: path.join(proj, 'demo.mp4'), allowed_out: path.join(proj, 'demo.frames', '001.jpg') }, fake),
    viewMedia({ path: path.join(proj, 'notes.mp4'), media: true }, fake),
  ];
  eq('Cv15-text-as-media-refused', textAsMedia.map((r) => [r.decision, r.reason, String(r.text).includes('SECRET')]),
    [['refused', 'not-media', false], ['refused', 'not-media', false], ['refused', 'not-media', false]]);
}

// S13 last: every line any row above wrote.
{
  const seen = new Set();
  let n = 0;
  const bad = [];
  for (const dir of LOG_DIRS) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    for (const l of logLines(dir)) {
      if (l.tool === 't') continue; // S14's synthetic fnd line
      n++;
      const keys = Object.keys(l).filter((k) => !['ts', 'project', 'lvl'].includes(k));
      if (keys[0] !== 'src' || keys[1] !== 'channel' || l.src !== 'slim' || !CHANNELS.includes(l.channel)) bad.push(JSON.stringify(l).slice(0, 160));
    }
  }
  check('S13-provenance', n > 20 && bad.length === 0, `${n} lines, bad: ${bad.slice(0, 3).join(' | ')}`);
}

for (const T of TEMPS) rmSync(T, { recursive: true, force: true });
console.log(`slim fixtures: ${pass} passed, ${fail} failed`);
if (fail) { console.log(failures.join('\n')); process.exitCode = 1; }
