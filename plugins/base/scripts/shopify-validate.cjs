#!/usr/bin/env node
/*
 * shopify-validate.cjs — validate one Admin GraphQL document against Shopify's schema without the
 * harness: the path for a session that loads no manifest MCP server (a cloud session).
 *
 * It spawns the manifest's server (`npx -y @shopify/dev-mcp@latest`, LIQUID=true,
 * OPT_OUT_INSTRUMENTATION=true) and speaks MCP over stdio, newline-delimited JSON-RPC: initialize →
 * notifications/initialized → learn_shopify_api (api admin, model `none`, a constant user_prompt —
 * never the caller's prompt) for a conversationId → validate. No temp files. The child is killed
 * when the run ends, except when it never sent one JSON-RPC line: npx may still be unpacking
 * into its `_npx` cache, and a kill there leaves a half-written install every later npx run fails
 * on. That child is left to finish the install and exit on stdin EOF.
 *
 * Usage:
 *   node shopify-validate.cjs [--file <path> | --code '<graphql>'] [--version <YYYY-MM>]
 *                             [--api admin] [--timeout <s>] [--json]
 *     --file     read the document from a file; without --file or --code it is read from stdin
 *     --code     the document as one argument
 *     --version  the Admin API version to validate against (default 2026-10)
 *     --api      admin only; anything else is a usage error
 *     --timeout  the total budget in seconds, 1-600 (default BASE_SHOPIFY_VALIDATE_TIMEOUT, else 90)
 *     --json     the validate tool's raw JSON-RPC result instead of its text; the server's stderr passes through
 *
 * stdout: `result=valid|invalid|unavailable` first, then the server's detail text verbatim.
 * Exit 0 = valid, 1 = invalid, 2 = usage, 3 = unavailable (no npx, spawn failure, timeout, protocol
 * error, BASE_SHOPIFY_VALIDATE=0) with one `error=<code>` line on stderr; `server_exited_early`
 * (npx exited before the server spoke) names the `_npx` dir to delete. Validation never blocks:
 * a caller sends the operation anyway on 3 and lets the API judge it.
 * Node built-ins only; child_process is required lazily.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_VERSION = '2026-10';
const DEFAULT_TIMEOUT_S = 90;
const USER_PROMPT = 'base shopify validate';
const MAX_BUFFER = 16 * 1024 * 1024;

const USAGE =
  "usage: shopify-validate.cjs [--file <path> | --code '<graphql>'] [--version <YYYY-MM>] [--api admin] [--timeout <s>] [--json]\n";

function usage(code, line) {
  if (line) process.stderr.write(line + '\n');
  (code ? process.stderr : process.stdout).write(USAGE);
  process.exit(code);
}

/** Seconds in 1-600, else null. */
function parseTimeout(v) {
  const n = Number(String(v).trim());
  return String(v).trim() !== '' && n >= 1 && n <= 600 ? n : null;
}

function parseArgs(argv) {
  const opts = { file: undefined, code: undefined, version: DEFAULT_VERSION, api: 'admin', timeout: undefined, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') usage(0);
    else if (a === '--json') opts.json = true;
    else if (['--file', '--code', '--version', '--api', '--timeout'].includes(a)) {
      const v = argv[++i];
      if (v === undefined || (a !== '--code' && v.startsWith('--'))) usage(2, 'error=missing_value flag=' + a);
      opts[a.slice(2)] = v;
    } else usage(2, 'error=unknown_arg arg=' + a);
  }
  if (opts.file !== undefined && opts.code !== undefined) usage(2, 'error=conflicting_input (--file or --code, not both)');
  if (opts.api !== 'admin') usage(2, 'error=unsupported_api value=' + opts.api + ' (admin only)');
  if (!/^\d{4}-\d{2}$/.test(opts.version)) usage(2, 'error=invalid_version value=' + opts.version + ' (YYYY-MM)');
  const raw = opts.timeout;
  opts.timeout = raw === undefined ? parseTimeout(process.env.BASE_SHOPIFY_VALIDATE_TIMEOUT || '') || DEFAULT_TIMEOUT_S : parseTimeout(raw);
  if (opts.timeout === null) usage(2, 'error=invalid_timeout value=' + raw + ' (1-600)');
  return opts;
}

function readCode(opts) {
  if (opts.code !== undefined) return opts.code;
  try {
    if (opts.file !== undefined) return fs.readFileSync(opts.file, 'utf8');
    if (process.stdin.isTTY) usage(2, 'error=missing_code (--file, --code or stdin)');
    return fs.readFileSync(0, 'utf8');
  } catch (e) {
    usage(2, 'error=unreadable_input ' + (opts.file !== undefined ? 'file=' + opts.file + ' ' : '') + '(' + e.code + ')');
  }
}

function unavailable(code, detail) {
  process.stdout.write('result=unavailable\n');
  process.stderr.write('error=' + code + (detail ? ' ' + String(detail).replace(/\s+/g, ' ').slice(0, 300) : '') + '\n');
  process.exitCode = 3;
}

/** The `_npx` dir npm installs the spec into: sha512 of the spec, first 16 hex chars, under the npm cache. */
function npxDir(spec) {
  const cache = process.env.npm_config_cache ||
    (process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA || os.homedir(), 'npm-cache') : path.join(os.homedir(), '.npm'));
  return path.join(cache, '_npx', require('crypto').createHash('sha512').update(spec).digest('hex').slice(0, 16));
}

/** The `Overall Status` line's verdict, INVALID tested first; null when the line is missing or names neither. */
function verdict(text) {
  const line = (text.match(/Overall Status:[^\n]*/) || [''])[0];
  return /\bINVALID\b/.test(line) ? 'INVALID' : /\bVALID\b/.test(line) ? 'VALID' : null;
}

function textOf(result) {
  return ((result && result.content) || []).filter((c) => c && c.type === 'text').map((c) => c.text).join('\n');
}

function run(opts, content) {
  const { spawn } = require('child_process');
  const win = process.platform === 'win32';
  const spec = '@shopify/dev-mcp@latest';
  let child;
  try {
    child = spawn(win ? 'npx.cmd' : 'npx', ['-y', spec], {
      env: { ...process.env, LIQUID: 'true', OPT_OUT_INSTRUMENTATION: 'true' },
      stdio: ['pipe', 'pipe', opts.json ? 'inherit' : 'ignore'],
      // A process group of its own, so the kill reaches the server npx started, not only npx.
      detached: !win,
      shell: win,
    });
  } catch (e) {
    return unavailable('spawn_failed', e.message);
  }

  let done = false;
  let serverUp = false;
  const pending = new Map();
  let nextId = 0;
  let buf = '';

  const finish = (fn) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    fn();
    try { child.stdin.destroy(); } catch (_) {}
    try { child.stdout.destroy(); } catch (_) {}
    if (!serverUp) return child.unref();
    try {
      if (win) child.kill();
      else process.kill(-child.pid, 'SIGKILL');
    } catch (_) {}
  };
  const timer = setTimeout(() => finish(() => unavailable('timeout', 'seconds=' + opts.timeout + (serverUp ? '' : ' phase=install'))), opts.timeout * 1000);

  child.on('error', (e) => finish(() => unavailable(e.code === 'ENOENT' ? 'npx_missing' : 'spawn_failed', e.message)));
  child.on('exit', (code, signal) => {
    const how = 'code=' + code + (signal ? ' signal=' + signal : '');
    finish(() => serverUp
      ? unavailable('server_exited', how)
      : unavailable('server_exited_early', how + ' hint=offline, or a half-written npx install: delete ' + npxDir(spec) + ' and retry'));
  });
  child.stdin.on('error', () => {});

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    if (buf.length > MAX_BUFFER) return finish(() => unavailable('bad_answer', 'frame over ' + MAX_BUFFER + ' bytes'));
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      let msg;
      try { msg = JSON.parse(line); } catch (_) { continue; }
      serverUp = true;
      if (!msg || typeof msg !== 'object' || 'method' in msg || !pending.has(msg.id)) continue;
      const resolve = pending.get(msg.id);
      pending.delete(msg.id);
      resolve(msg);
    }
  });

  const send = (obj) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...obj }) + '\n');
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, (msg) => (msg.error ? reject(new Error(method + ': ' + (msg.error.message || JSON.stringify(msg.error)))) : resolve(msg.result)));
      send({ id, method, params });
    });
  const call = async (name, args) => {
    const result = await request('tools/call', { name, arguments: args });
    if (!result || result.isError) throw Object.assign(new Error(name + ': ' + (textOf(result) || 'no result')), { code: 'tool_error' });
    return result;
  };

  (async () => {
    await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'base-shopify-validate', version: '1' } });
    send({ method: 'notifications/initialized' });
    const learned = textOf(await call('learn_shopify_api', { api: 'admin', model: 'none', user_prompt: USER_PROMPT, version: opts.version }));
    const cid = (learned.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i) || [])[0];
    if (!cid) throw Object.assign(new Error('learn_shopify_api returned no conversationId'), { code: 'no_conversation_id' });
    const result = await call('validate', { conversationId: cid, api: 'admin', version: opts.version, code: [{ content }] });
    const text = textOf(result);
    const status = verdict(text);
    if (!status) throw Object.assign(new Error('no Overall Status in the validate answer'), { code: 'bad_answer' });
    finish(() => {
      process.stdout.write('result=' + status.toLowerCase() + '\n' + (opts.json ? JSON.stringify(result) : text.trimEnd()) + '\n');
      process.exitCode = status === 'VALID' ? 0 : 1;
    });
  })().catch((e) => finish(() => unavailable(e.code || 'protocol', e.message)));
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (process.env.BASE_SHOPIFY_VALIDATE === '0') return unavailable('disabled', 'BASE_SHOPIFY_VALIDATE=0');
  const content = readCode(opts);
  if (!content.trim()) usage(2, 'error=empty_code');
  run(opts, content);
}

if (require.main === module) main();

module.exports = { parseTimeout, verdict, npxDir, DEFAULT_TIMEOUT_S };
