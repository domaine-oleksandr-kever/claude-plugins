#!/usr/bin/env node
/*
 * browser-mcp.cjs — launches one of base's browser MCP servers (manifest `mcpServers`) headless, so a session
 * never opens a Chrome window that takes keyboard focus. Usage: browser-mcp.cjs <command> [args…]: runs
 * `<command> <args…> --headless`, or without `--headless` when BASE_BROWSER_HEADED=1. stdio is inherited (the
 * MCP stream passes through untouched), SIGINT/SIGTERM/SIGHUP go to the server, and the server's exit code or
 * signal is this process's (a signal Node ignores or handles itself becomes exit 128+n). Node built-ins only.
 */
'use strict';

const { spawn } = require('child_process');
const os = require('os');

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];
// Node starts its inspector on SIGUSR1 instead of dying, so that one is never re-raised.
const NO_RERAISE = new Set(['SIGUSR1']);

/** The argv the server runs with: `args` plus `--headless`, unless `env.BASE_BROWSER_HEADED` is exactly '1'. */
function serverArgs(args, env) {
  return env.BASE_BROWSER_HEADED === '1' ? args.slice() : [...args, '--headless'];
}

function main(argv) {
  const [command, ...args] = argv;
  if (!command) {
    process.stderr.write('browser-mcp: usage: browser-mcp.cjs <command> [args…]\n');
    process.exitCode = 2;
    return;
  }
  // npx is a .cmd shim on Windows, which spawn runs only through a shell.
  const child = spawn(command, serverArgs(args, process.env), { stdio: 'inherit', shell: process.platform === 'win32' });
  const forward = {};
  for (const s of SIGNALS) {
    forward[s] = () => {
      try {
        child.kill(s);
      } catch {}
    };
    process.on(s, forward[s]);
  }
  child.on('error', (e) => {
    process.stderr.write('browser-mcp: cannot start ' + command + ' (' + (e.code || e.message) + ')\n');
    process.exit(127);
  });
  child.on('exit', (code, signal) => {
    for (const s of SIGNALS) process.removeListener(s, forward[s]);
    if (!signal) process.exit(code === null ? 1 : code);
    if (!NO_RERAISE.has(signal)) process.kill(process.pid, signal);
    // Still alive: Node ignores the signal (SIGPIPE) or handles it; exit as a shell reports a signal death.
    process.exit(128 + (os.constants.signals[signal] || 0));
  });
}

module.exports = { serverArgs };

if (require.main === module) main(process.argv.slice(2));
