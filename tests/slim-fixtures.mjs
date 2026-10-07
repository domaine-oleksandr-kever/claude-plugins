#!/usr/bin/env node
// Suite for plugins/slim/scripts/slim.cjs — slim's core — run on the real fixtures in tests/fixtures/
// and on synthetic inputs built inline. Every case spawns the core in its own temp dir with an explicit
// env, so a developer's exported FND_MCP_SLIM_* / SLIM_* never reaches it and no row writes to the real
// report log. Also the drift gate: the compressors slim carries must stay byte-identical to fnd's.
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
const FND_HOOK = path.join(ROOT, 'plugins/fnd/hooks/mcp-slim.cjs');
const MODS = path.join(ROOT, 'plugins/slim/hooks/mods');
const BOUND = 32768 + 1200;
const FIX = path.join(ROOT, 'tests/fixtures');
const LOG = 'fnd-mcp-slim-debug.log';

// The envelope the hooks module sends, keys in its order (agentId, pre, bytes_in only when set).
const ENVELOPE_KEYS = ['v', 'channel', 'tool', 'tool_use_id', 'tool_input', 'tool_response', 'is_error', 'cwd', 'session_id', 'agentId', 'pre', 'bytes_in'];
const M1_KEYS = ENVELOPE_KEYS.slice(0, 9);
const ENGINES = ['json', 'log', 'jsx', 'stub'];

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
  eq('F3-decision', [a.decision, a.record.engine], ['compressed', 'jsx']);
}
{
  const T = newT();
  const a = call('F4', T, envelope(T, F4));
  eq('F4-decision', [a.decision, a.reason, a.record.engine], ['stubbed', 'weak-gain', 'stub']);
  const res = typeof a.result === 'string' ? a.result : '';
  check('F4-stub-header', res.startsWith('<<slim stub>> mcp__x__y returned '), res.slice(0, 80));
  check('F4-recipe-own-cli', res.includes(`node ${SLIM_JSON_CLI} `), 'recipe does not name slim\'s json-slim.cjs');
  check('F4-figure', (a.figure || '').startsWith('slim: stub ') && res.includes(a.figure), a.figure);
  check('F4-no-fnd-marks', !res.includes('<<fnd-mcp-slim stub>>') && !/^fnd-mcp-slim:/m.test(res), 'fnd mark in a slim stub');
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
  eq('S2-jsonl', [a.decision, a.record.engine, a.record.stages], ['compressed', 'json', ['jsonl', 'crush']]);
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
  for (const f of ['slim.cjs', 'env-file.cjs']) copyFileSync(path.join(SCRIPTS, f), path.join(T, 'p/scripts', f));
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
  check('S14-help', h.status === 0 && h.stdout.trim().split('\n').length === 3, h.stdout);
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
    mkdirSync(`${T}/.claude/fnd-tmp/playwright`, { recursive: true });
    writeFileSync(`${T}/.claude/fnd-tmp/playwright/old.png`, 'png');
    old(`${T}/.claude/fnd-tmp/playwright/old.png`);
  };
  const T = newT();
  seed(T);
  call('S17', T, envelope(T, F1));
  check('S17-swept', !existsSync(`${T}/spill/fnd-crush-dead.json`) && existsSync(`${T}/spill/.fnd-mcp-slim-sweep`), 'stale spill kept or no marker');
  check('S17-no-project-pass', existsSync(`${T}/.claude/fnd-tmp/playwright/old.png`), 'the playwright dir was pruned');
  const T2 = newT();
  seed(T2);
  call('S17-ttl0', T2, envelope(T2, F1), { SLIM_TTL: '0' });
  check('S17-ttl0-kept', existsSync(`${T2}/spill/fnd-crush-dead.json`), 'SLIM_TTL=0 still swept');
}
for (const f of ['json-slim', 'log-slim', 'adf-to-md', 'adf-colors', 'figma-node-slim', 'env-file']) {
  const a = readFileSync(path.join(FND_SCRIPTS, `${f}.cjs`));
  const b = readFileSync(path.join(SCRIPTS, `${f}.cjs`));
  check(`S18-identical-${f}`, a.equals(b), `plugins/slim/scripts/${f}.cjs drifted from plugins/fnd/scripts/${f}.cjs — copy it again`);
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
  const src = readFileSync(path.join(MODS, 'mcp.ts'), 'utf8');
  const block = /const envelope = \{\n([\s\S]*?)\n {4}\}\n/.exec(src);
  const keys = [];
  for (const line of (block ? block[1] : '').split('\n')) for (const m of line.matchAll(/(?:^\s*|[{,]\s*)([A-Za-z_]\w*)\s*(?=[:,}])/g)) keys.push(m[1]);
  eq('S23-mod-keys', keys, ENVELOPE_KEYS);
  const T = newT();
  eq('S23-envelope-keys', Object.keys(envelope(T, F1)), M1_KEYS);
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
      if (keys[0] !== 'src' || keys[1] !== 'channel' || l.src !== 'slim' || l.channel !== 'mcp') bad.push(JSON.stringify(l).slice(0, 160));
    }
  }
  check('S13-provenance', n > 20 && bad.length === 0, `${n} lines, bad: ${bad.slice(0, 3).join(' | ')}`);
}

for (const T of TEMPS) rmSync(T, { recursive: true, force: true });
console.log(`slim fixtures: ${pass} passed, ${fail} failed`);
if (fail) { console.log(failures.join('\n')); process.exitCode = 1; }
