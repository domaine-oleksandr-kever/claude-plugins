#!/usr/bin/env node
// Suite for plugins/slim/scripts/slim.cjs — slim's Claude Code delivery — run end to end on the real
// fixtures in tests/fixtures/ and on synthetic inputs built inline: decisions, restored result shapes,
// records and the report, per channel. Every case spawns the core in its own temp dir with an explicit
// env, so a developer's exported FND_MCP_SLIM_* / SLIM_* never reaches it and no row writes to the real
// report log. The engines themselves are tested as pure functions in tests/slim-engines.mjs.
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
const SLIM_JSON_CLI = path.join(SCRIPTS, 'json-slim.cjs');
const FND_SCRIPTS = path.join(ROOT, 'plugins/fnd/scripts');
const FROZEN_JSON = path.join(SCRIPTS, 'json-slim.cjs');
const FND_HOOK = path.join(ROOT, 'plugins/fnd/hooks/mcp-slim.cjs');
const MODS = path.join(ROOT, 'plugins/slim/hooks/mods');
const BOUND = 32768 + 1200;
const FIX = path.join(ROOT, 'tests/fixtures');
const LOG = 'fnd-mcp-slim-debug.log';

// The envelope the hooks module sends, keys in its order (agentId, pre, bytes_in only when set).
const ENVELOPE_KEYS = ['v', 'channel', 'tool', 'tool_use_id', 'tool_input', 'tool_response', 'is_error', 'cwd', 'session_id', 'agentId', 'pre', 'bytes_in'];
const M1_KEYS = ENVELOPE_KEYS.slice(0, 9);
const CHANNELS = ['mcp', 'bash', 'read', 'webfetch', 'websearch', 'grep', 'glob', 'agent', 'attachment', 'lookup'];
const ENGINES = ['json', 'jsonl', 'log', 'html', 'figma', 'adf', 'text', 'stub'];

const F1 = readFileSync(path.join(FIX, 'jql-search-ELC.json'), 'utf8');
const F2 = JSON.parse(readFileSync(path.join(FIX, 'mcp-envelope-jira.json'), 'utf8'));
const F3 = readFileSync(path.join(FIX, 'figma-design-context.jsx'), 'utf8');
const F4 = readFileSync(path.join(FIX, 'jira-issue-ELC-104.json'), 'utf8');
const F5 = readFileSync(path.join(FIX, 'figma-metadata-3326-39542.xml'), 'utf8');

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
  check('F4-recipe-own-cli', res.includes(`node ${SLIM_JSON_CLI} `), 'recipe does not name slim\'s json-slim.cjs');
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
  // Over the bound only a handle this user owns in a spill dir counts: S6d's sits in fnd's dir.
  const dirOf = (k) => (k === 'd' ? { FND_MCP_SLIM_DIR: `${T}/spill` } : {});
  for (const k of Object.keys(shapes)) {
    const T2 = newT();
    const a = call(`S6${k}`, T2, envelope(T2, shapes[k]), dirOf(k));
    eq(`S6${k}-already-slim`, [a.decision, a.reason], ['passthrough', 'already-slim']);
    eq(`S6${k}-line-at-2`, logLines(`${T2}/spill`).map((l) => l.reason), ['already-slim']);
    const T3 = newT();
    call(`S6${k}-1`, T3, envelope(T3, shapes[k]), { SLIM_DEBUG: '1', ...dirOf(k) });
    eq(`S6${k}-no-line-at-1`, logLines(`${T3}/spill`).length, 0);
  }
  const T4 = newT();
  const forged = call('S7', T4, envelope(T4, `${STUB0_OUT}x`, {}), { FND_MCP_SLIM_DIR: `${T}/spill` });
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
// fnd's real hook beneath: whatever it emits, at either stub setting, slim must stand down on.
{
  const T = newT();
  for (const stub of ['1', '0']) {
    for (const [name, response] of [['F1', F1], ['F4', F4], ['F4-blocks', [{ type: 'text', text: F4 }]]]) {
      const out = fndSlim(T, response, { FND_MCP_SLIM_STUB: stub });
      const tag = `X-${name}-stub${stub}`;
      check(`${tag}-fnd-emitted`, out !== null, 'fnd emitted nothing');
      if (out === null) continue;
      if (stub === '0' && name === 'F4') check(`${tag}-over-bound`, bytes(out) > BOUND, String(bytes(out)));
      const a = call(tag, T, envelope(T, out), { FND_MCP_SLIM_DIR: `${T}/fspill` });
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
  for (const f of ['slim.cjs', 'env-file.cjs']) copyFileSync(path.join(SCRIPTS, f), path.join(T, 'p/scripts', f));
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
  check('S14-help', h.status === 0 && h.stdout.trim().split('\n').length === 5, h.stdout);
  check('S14-by-channel', /^ {2}by channel: mcp \d+ → \d+ B \([\d.]+% saved\)$/m.test(r.stdout), r.stdout);
  const rec = spawn(T, JSON.stringify({ tool_use_id: 'toolu_l', decision: 'answered', rung: 'url', engine: 'html', model: 'haiku', tokens: { input: 1200, output: 40 }, bytes_in: 60000, bytes_out: 300, ms: 900, cwd: T }), { args: ['--record'] });
  check('S14-record-silent', rec.status === 0 && rec.stdout === '', `exit ${rec.status}`);
  const l = spawn(T, '', { args: ['--report', log] });
  check('S14-lookup-line', /^ {2}lookup: 1 calls \(1 answered\) · 1200 in \/ 40 out tokens · haiku×1$/m.test(l.stdout), l.stdout);
  check('S14-lookup-not-in-totals', (/^ {2}by channel: (.*)$/m.exec(l.stdout) || [])[1] === (/^ {2}by channel: (.*)$/m.exec(r.stdout) || [])[1], 'a lookup line moved the byte totals');
}
{
  const T = newT();
  const a = call('S15a', T, envelope(T, F1), { SLIM_DIR: undefined, FND_MCP_SLIM_DIR: `${T}/fdir` });
  check('S15a-fallback-dir', (handleOf(a.result || '') || '').startsWith(`${T}/fdir/`) && logLines(`${T}/fdir`).length === 1, handleOf(a.result || ''));
  const T2 = newT();
  const b = call('S15b', T2, envelope(T2, F1), { FND_MCP_SLIM_DIR: `${T2}/fdir` });
  check('S15b-own-dir-wins', (handleOf(b.result || '') || '').startsWith(`${T2}/spill/`) && logLines(`${T2}/spill`).length === 1 && !existsSync(`${T2}/fdir`), handleOf(b.result || ''));
  const T3 = newT();
  call('S15c', T3, envelope(T3, [{ type: 'text', text: F5 }]), { SLIM_DEBUG: undefined, FND_MCP_SLIM_DEBUG: '1' });
  eq('S15c-fallback-debug', logLines(`${T3}/spill`).map((l) => [l.reason, l.lvl]), [['non-json', 1]]);
  const T4 = newT();
  call('S15d', T4, envelope(T4, F1), { SLIM_DEBUG: '0', FND_MCP_SLIM_DEBUG: '2' });
  check('S15d-own-debug-wins', !existsSync(path.join(T4, 'spill', LOG)), 'a log was written at SLIM_DEBUG=0');
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
  // A shared name lives as long as the longer TTL says: SLIM_TTL=1 cannot cut fnd's 72 h short.
  const T3 = newT();
  seed(T3);
  call('S17-ttl-longer', T3, envelope(T3, F1), { SLIM_TTL: '1', FND_MCP_SLIM_TTL: '72' });
  check('S17-ttl-longer-kept', existsSync(`${T3}/spill/fnd-crush-dead.json`), 'SLIM_TTL=1 swept a 48 h file fnd keeps for 72 h');
  const T4 = newT();
  seed(T4);
  call('S17-ttl-fnd0', T4, envelope(T4, F1), { FND_MCP_SLIM_TTL: '0' });
  check('S17-ttl-fnd0-kept', existsSync(`${T4}/spill/fnd-crush-dead.json`), 'FND_MCP_SLIM_TTL=0 still swept');
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
{
  const T = newT();
  call('S22-make', T, envelope(T, F1), { SLIM_TTL: '0' });
  const spill = mcpSpills(`${T}/spill`)[0];
  mkdirSync(`${T}/.claude/fnd-tmp/playwright`, { recursive: true });
  writeFileSync(`${T}/.claude/fnd-tmp/playwright/old.png`, 'png');
  old(`${T}/.claude/fnd-tmp/playwright/old.png`);
  check('S22-no-marker', !existsSync(`${T}/spill/.fnd-mcp-slim-sweep`), 'marker present before the CLI run');
  const cli = { extra: { SLIM_DIR: undefined, SLIM_DEBUG: undefined, FND_MCP_SLIM_DIR: `${T}/spill` } };
  const r = spawn(T, '', { ...cli, args: [path.join(T, 'spill', spill || 'missing')], script: SLIM_JSON_CLI });
  check('S22-cli-runs', r.status === 0 && existsSync(`${T}/spill/.fnd-mcp-slim-sweep`), `exit ${r.status} ${r.stderr}`);
  check('S22-project-pass-skipped', existsSync(`${T}/.claude/fnd-tmp/playwright/old.png`), 'slim\'s recovery CLI pruned the project');
  // Control: fnd's own CLI does run that pass, so the row above has teeth.
  unlinkSync(`${T}/spill/.fnd-mcp-slim-sweep`);
  const c = spawn(T, '', { ...cli, args: [path.join(T, 'spill', spill || 'missing')], script: path.join(FND_SCRIPTS, 'json-slim.cjs') });
  check('S22-control', c.status === 0 && !existsSync(`${T}/.claude/fnd-tmp/playwright/old.png`), 'fnd\'s CLI left the stale file: the S22 row proves nothing');
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
}

// C-webfetch, C-websearch, C-grep, C-glob, C-agent
{
  const T = newT();
  const wf = { bytes: bytes(PAGE), code: 200, codeText: 'OK', result: PAGE, durationMs: 120, url: 'https://shop.example/p' };
  const a = call('Cw1', T, chEnv(T, 'webfetch', 'WebFetch', { url: 'https://shop.example/p', prompt: 'list the scripts' }, wf));
  eq('Cw1-html', [a.decision, a.record.engine, a.record.channel], ['compressed', 'html', 'webfetch']);
  eq('Cw1-keys', Object.keys(a.result || {}), Object.keys(wf));
  check('Cw1-result', String((a.result || {}).result).startsWith('# Northwind Ceramics') && (a.result || {}).url === wf.url, String((a.result || {}).result).slice(0, 80));

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
  const T = newT();
  const env2 = chEnv(T, 'attachment', 'Attachment', { type: 'file', origin: 'user', shape: 'numbered' }, null, { pre: 'not-covered', bytes_in: 70000 });
  const a = call('Ct1', T, env2);
  eq('Ct1-pre', [a.decision, a.reason], ['passthrough', 'not-covered']);
  eq('Ct1-line-at-2', logLines(`${T}/spill`).map((l) => [l.channel, l.reason, l.format, l.bytes_in]), [['attachment', 'not-covered', 'numbered', 70000]]);
  const T1 = newT();
  call('Ct1b', T1, chEnv(T1, 'attachment', 'Attachment', { type: 'file', origin: 'user', shape: 'raw' }, null, { pre: 'not-covered', bytes_in: 70000 }), { SLIM_DEBUG: '1' });
  eq('Ct1-none-at-1', logLines(`${T1}/spill`).length, 0);

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
