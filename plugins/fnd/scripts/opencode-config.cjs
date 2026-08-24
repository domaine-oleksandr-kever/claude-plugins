#!/usr/bin/env node
// opencode-config — print the three configuration blocks an OpenCode install pastes into its
// own opencode.json (docs/README.opencode.md, install steps 3, 4 and 5), with this clone's
// absolute paths already filled in.
//
//   node opencode-config.cjs           three labeled blocks, in the doc's step order
//   node opencode-config.cjs --json    one merged {"mcp", "permission", "instructions"} object
//
// opencode.json belongs to the user: nothing here — and no installer or hook — writes or edits
// it. This command only renders what has to be pasted, so the paths never have to be typed.
'use strict';

const fs = require('fs');
const path = require('path');

// Resolved from this file's own location, never from cwd: the same paste must come out of any
// working directory, and the printed paths are what a user's config will point at forever.
const PLUGIN_ROOT = realOrSelf(path.join(__dirname, '..'));
const HOOKS_DIR = realOrSelf(path.join(PLUGIN_ROOT, 'hooks'));

const MCP_REL = 'plugins/fnd/opencode/mcp-fragment.json';
const PERM_REL = 'plugins/fnd/opencode/permission-fragment.example.json';
const GENERATOR = 'node plugins/fnd/scripts/gen-host-adapters.cjs';

// The one static convention the adapter injects itself, wherever store credentials are detected.
// A static copy would deliver it a second time in exactly the sessions that already have it.
const ADAPTER_INJECTED = 'store-access.md';

function realOrSelf(p) {
  try {
    return fs.realpathSync(p);
  } catch (_) {
    return path.resolve(p);
  }
}

// statSync, not a dirent check: a hooks entry may legitimately be a symlink to a real file, and
// only the target's kind decides whether a host can read it.
function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch (_) {
    return false;
  }
}

function die(msg) {
  process.stderr.write('opencode-config: ' + msg + '\n');
  process.exit(2);
}

function usage(stream) {
  stream.write([
    'usage: opencode-config.cjs [--json]',
    '',
    '  (no flags)   the three opencode.json blocks as labeled, fenced JSON — steps 3, 4 and 5',
    '               of docs/README.opencode.md',
    '  --json       the same three blocks merged into one JSON object on stdout',
    '',
  ].join('\n'));
}

function readJson(abs, rel) {
  let raw;
  try {
    raw = fs.readFileSync(abs, 'utf8');
  } catch (e) {
    return { error: rel + (e && e.code === 'ENOENT' ? ' is missing' : ' is unreadable (' + (e && e.code) + ')') };
  }
  try {
    return { value: JSON.parse(raw) };
  } catch (e) {
    return { error: rel + ' is not valid JSON (' + (e && e.message) + ')' };
  }
}

function objectAt(parsed, key, rel) {
  const v = parsed && typeof parsed === 'object' ? parsed[key] : undefined;
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    die(rel + ' carries no `' + key + '` object');
  }
  return v;
}

function readMcp() {
  const r = readJson(path.join(PLUGIN_ROOT, 'opencode', 'mcp-fragment.json'), MCP_REL);
  // Generated file: every failure has the same fix, and naming it here is what keeps a partial
  // checkout from reading as a broken plugin.
  if (r.error) die(r.error + ' — regenerate it: ' + GENERATOR);
  // The fragment's `_comment` note to a human reader sits BESIDE `mcp`, never inside it, so
  // selecting the sub-object is what keeps it out of a config that would carry it as valid JSON.
  return objectAt(r.value, 'mcp', MCP_REL);
}

function readPermission() {
  const r = readJson(path.join(PLUGIN_ROOT, 'opencode', 'permission-fragment.example.json'), PERM_REL);
  if (r.error) die(r.error);
  return objectAt(r.value, 'permission', PERM_REL);
}

// Derived from the hooks directory, not from a list in this file: a convention file added under
// hooks/ appears in the paste with no change here, which is the only way the two stay in step.
function readInstructions() {
  let names;
  try {
    names = fs.readdirSync(HOOKS_DIR);
  } catch (e) {
    die('cannot read plugins/fnd/hooks (' + (e && e.code) + ') — is this checkout complete?');
  }
  // Sorted because the paths land in a file the user diffs: readdir order is filesystem-defined,
  // and an unordered render makes every re-run look like a config change. The stat drops entries
  // a host could not read anyway — a directory named `*.md`, a dangling link.
  const statics = names
    .filter((n) => n.endsWith('.md') && n !== ADAPTER_INJECTED)
    .sort()
    .map((n) => path.join(HOOKS_DIR, n))
    .filter(isFile);
  if (!statics.length) {
    die('no static convention files in plugins/fnd/hooks — is this checkout complete?');
  }
  return statics;
}

function block(header, body) {
  return header + '\n```json\n' + JSON.stringify(body, null, 2) + '\n```\n';
}

function main(argv) {
  let asJson = false;
  for (const a of argv) {
    if (a === '--json') asJson = true;
    else {
      process.stderr.write('opencode-config: unknown argument \'' + a + '\'\n');
      usage(process.stderr);
      process.exit(2);
    }
  }

  const mcp = readMcp();
  const permission = readPermission();
  const instructions = readInstructions();

  if (asJson) {
    process.stdout.write(JSON.stringify({ mcp, permission, instructions }, null, 2) + '\n');
    return;
  }

  process.stdout.write([
    block('step 3 of docs/README.opencode.md — "mcp": merge into the top level of your opencode.json', { mcp }),
    block('step 4 of docs/README.opencode.md — "permission": merge into the top level, next to "mcp"', { permission }),
    block('step 5 of docs/README.opencode.md — "instructions": merge into the top level; the paths point into this clone', { instructions }),
  ].join('\n'));
}

if (require.main === module) {
  // A downstream `| head` closes stdout mid-write; the EPIPE (Windows: `code: 'EOF'`) surfaces
  // async and would crash the process after the consumer already got its bytes.
  const quietOnEpipe = (s) => s.on('error', (e) => {
    if (e && (e.code === 'EPIPE' || e.code === 'EOF')) process.exit(0);
    throw e;
  });
  quietOnEpipe(process.stdout);
  quietOnEpipe(process.stderr);
  main(process.argv.slice(2));
}
