#!/usr/bin/env node
// Simulation harness for plugins/fnd/opencode/fnd-plugin.js — the OpenCode hook adapter.
// The plugin module is imported for real and fed synthetic OpenCode hook events; every
// assertion is about what the ADAPTER does with what the canonical hooks answer, never about
// the hook logic itself (hooks-sim.sh and no-verify-bypass-matrix.sh own that):
//   L cases — module shape: exactly ONE export (a second one would double-wire every hook)
//             and the four hook keys the OpenCode plugin protocol calls
//   G cases — tool.execute.before: a guard's exit 2 becomes a thrown block carrying the
//             guard's own reason; a matrix subset (block + allow rows lifted from
//             tests/no-verify-bypass-matrix.sh) keeps its verdicts through the adapter;
//             non-bash tools and commandless args never reach a guard, and a guard that
//             cannot be RUN blocks the git commands it would have inspected (a broken install
//             is not an allow) while leaving every other command alone
//   A cases — tool.execute.before → hooks/spill-access.sh: a bash / read / grep call that touches
//             an MCP spill appends one `entry:"access"` line to the compressor's debug log (this
//             host DOES route the file readers, unlike Cursor), a blocked command records nothing,
//             and the switch, a missing path argument and a broken hook are all silent no-ops
//   P cases — permission-fragment.example.json: the `--auto` backstop for an adapter that never
//             loaded — deny globs, last-match-wins ordering, and re-allows that cannot span a
//             `&&` into a bypass
//   M cases — tool.execute.after: an MCP whale is rewritten IN PLACE (output.output), the
//             spill it hands back is real, small results / builtin tools / non-string output
//             / FND_MCP_SLIM=0 are untouched, and the tool name reaches mcp-slim in the
//             `mcp__server__tool` spelling the debug log and --report read on every host
//   C cases — chat.message: the detection-gated store-access block is injected once per
//             session (and again after session.deleted), statics are never injected, a
//             prompt-JSON block offloads each spilled blob in place byte-exactly, and
//             FND_PROMPT_JSON=0 / assistant messages / empty parts are left alone
//   H cases — FND_HOST_TRACE: the two events the adapter COMPOSES record themselves (host
//             `opencode`, hook `fnd-plugin`), a skipped MCP result leaves a `skip` line, an assistant message records nothing, off writes
//             no file, and every line a run produces — spawned scripts included — carries the
//             host tag this adapter assigns
// Not covered here: the context-monitor half of user-prompt.cjs has no producer on OpenCode
// (it reads a Claude Code transcript path this host does not have), so the additionalContext
// branch of chat.message is exercised only through the session-context path that shares its
// injection helper. Bun-specific behavior (the plugin's real runtime) is M10c.
// Exit 0 = all green.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN_FILE = path.join(ROOT, 'plugins', 'fnd', 'opencode', 'fnd-plugin.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fnd-opencode-sim-'));
process.on('exit', () => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

// Hermetic env: a developer's exported switches (a live debug log, a custom spill dir) must
// not decide what these cases assert.
for (const k of Object.keys(process.env)) if (k.startsWith('FND_')) delete process.env[k];
process.env.FND_MCP_SLIM_DIR = path.join(TMP, 'spill');

let pass = 0;
let fail = 0;
const failures = [];
const ok = () => { pass += 1; };
const bad = (label, msg) => { fail += 1; failures.push(`  [${label}] ${msg}`); };
const assert = (label, cond, msg) => (cond ? ok() : bad(label, msg || 'assertion failed'));
const assertEq = (label, got, want) =>
  (got === want ? ok() : bad(label, `expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`));
const assertContains = (label, hay, needle) =>
  (String(hay).includes(needle) ? ok() : bad(label, `missing: ${needle}`));
const assertAbsent = (label, hay, needle) =>
  (String(hay).includes(needle) ? bad(label, `unexpected: ${needle}`) : ok());

// Node only detects ESM syntax in an extension-less-config .js file from 22.12 on; older
// runtimes parse it as CommonJS and throw. A .mjs SYMLINK gets the right parse without a
// copy — Node resolves symlinks before setting import.meta.url, so the plugin root the
// module derives from it still points into the repo.
async function loadModule() {
  try {
    return await import(pathToFileURL(PLUGIN_FILE).href);
  } catch (_) {
    const link = path.join(TMP, 'fnd-plugin.mjs');
    try { fs.symlinkSync(PLUGIN_FILE, link); } catch (_) {}
    return import(pathToFileURL(link).href);
  }
}

const mod = await loadModule();

// L — module shape ------------------------------------------------------------------------
const exportedFns = Object.keys(mod).filter((k) => typeof mod[k] === 'function');
assertEq('L1-single-export', exportedFns.join(','), 'FndPlugin');
assert('L2-no-default', mod.default === undefined, 'a default export would register the plugin twice');

const newPlugin = (dir) => mod.FndPlugin({ directory: dir });
const hooks = await newPlugin(TMP);
for (const key of ['chat.message', 'tool.execute.before', 'tool.execute.after', 'event']) {
  assert(`L3-hook-${key}`, typeof hooks[key] === 'function', `missing hook ${key}`);
}

// G — tool.execute.before (git guards) ------------------------------------------------------
async function runBash(command, tool = 'bash') {
  const output = { args: { command } };
  try {
    await hooks['tool.execute.before']({ tool, sessionID: 'g', callID: 'c1' }, output);
    return { blocked: false, message: '', args: output.args };
  } catch (e) {
    return { blocked: true, message: (e && e.message) || '', args: output.args };
  }
}

// Subset of tests/no-verify-bypass-matrix.sh — one row per mechanism, so a break in the
// adapter's stdin shape or exit-code reading shows up as a whole class going the wrong way.
const guardRows = [
  ['block', 'G01-plain-long', 'git commit --no-verify -m "x"'],
  ['block', 'G02-plain-short', 'git commit -n -m "x"'],
  ['block', 'G03-bundled', 'git commit -anm "wip"'],
  ['block', 'G04-quoted-C-arg', 'git -C "." commit -n'],
  ['block', 'G05-hooksPath-c', 'git -c core.hooksPath=/dev/null commit -m x'],
  ['block', 'G06-hooksPath-config', 'git config core.hooksPath /dev/null && git commit -m x'],
  ['block', 'G07-push-long', 'git push --no-verify'],
  ['block', 'G08-merge-long', 'git merge --no-verify feature/x'],
  ['block', 'G09-rm-husky', 'rm .husky/pre-commit && git commit -m "x"'],
  ['block', 'G10-husky-env', 'HUSKY=0 git commit -m "x"'],
  ['block', 'G11-sh-wrap', 'sh -c "git commit -n -m x"'],
  ['block', 'G12-trailer-multiline', 'git commit -m "feat: x\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>"'],
  ['block', 'G13-generated-with', 'git commit -m "x\n\n🤖 Generated with [Claude Code]"'],
  ['allow', 'G20-plain', 'git commit -m "safe change"'],
  ['allow', 'G21-flag-in-msg', 'git commit -m "do not use --no-verify"'],
  ['allow', 'G22-no-edit', 'git commit --amend --no-edit'],
  ['allow', 'G23-push-dry-run', 'git push -n origin main'],
  ['allow', 'G24-hooksPath-read', 'git config --get core.hooksPath'],
  ['allow', 'G25-cat-husky', 'cat .husky/pre-commit && git commit -m x'],
  ['allow', 'G26-chmod-restore', 'chmod +x .husky/pre-commit && git commit -m x'],
  ['allow', 'G27-human-coauthor', 'git commit -m "pair work\n\nCo-Authored-By: Jane Doe <jane@corp.example>"'],
  ['allow', 'G28-non-git', 'npm run commit'],
];
for (const [expect, label, cmd] of guardRows) {
  const r = await runBash(cmd);
  assertEq(label, r.blocked ? 'block' : 'allow', expect);
}

// The block message is the guard's own stderr — the model has to read WHY, not "blocked".
const noVerify = await runBash('git commit --no-verify -m "x"');
assertContains('G30-reason-no-verify', noVerify.message, '--no-verify');
assertContains('G31-reason-reference', noVerify.message, 'references/commit-message-format.md');
const attribution = await runBash('git commit -m "x\n\nCo-Authored-By: Claude <noreply@anthropic.com>"');
assertContains('G32-reason-attribution', attribution.message, 'no AI attribution');

// Guards are a Bash-tool contract: another tool carrying the same string is not a shell call.
const nonBash = await runBash('git commit --no-verify -m "x"', 'write');
assertEq('G33-non-bash-tool', nonBash.blocked, false);
const noCommand = await (async () => {
  const output = { args: { filePath: '/tmp/x' } };
  try {
    await hooks['tool.execute.before']({ tool: 'bash' }, output);
    return false;
  } catch (_) {
    return true;
  }
})();
assertEq('G34-no-command', noCommand, false);

// The adapter must not touch the arguments it forwards.
const passthroughArgs = await runBash('git status');
assertEq('G35-args-untouched', passthroughArgs.args.command, 'git status');

// A guard that cannot RUN reaches no verdict. The no-verify guard fails CLOSED on the commands
// it would have inspected — a partial install must not silently un-arm the commit guard, and
// the Cursor shim denies the identical case — while ordinary commands carry on untouched.
const realPath = process.env.PATH;
const realWrite = process.stderr.write.bind(process.stderr);
let captured = '';
process.stderr.write = (chunk) => { captured += chunk; return true; };
process.env.PATH = '';
const unrunnable = await runBash('git commit --no-verify -m "x"');
const unrunnableNonGit = await runBash('ls -la');
process.env.PATH = realPath;
process.stderr.write = realWrite;
assertEq('G36-guard-unrunnable-fails-closed', unrunnable.blocked, true);
assertContains('G37-unrunnable-reason', unrunnable.message, 'could not run');
assertEq('G38-unrunnable-non-git-open', unrunnableNonGit.blocked, false);
// A guard that cannot run is an install defect: silence would leave a developer with an
// un-armed guard layer and nothing to notice it by.
assertContains('G39-unrunnable-warned', captured, 'no-verify-bypass.sh reached no verdict');

// A — tool.execute.before → hooks/spill-access.sh ------------------------------------------
// Measurement only: `json-slim --report` used to call a platform-overflow whale MISSED whenever
// the agent read the spill with anything but json-slim. These cases pin that the adapter feeds
// the recorder — for the shell tool AND for this host's file readers, which do carry a path.
const SPILL = '/p/tool-results/b1z10evqs.txt';
let accessDir = 0;
async function runAccess(tool, args, env = {}) {
  accessDir += 1;
  const dir = path.join(TMP, `access-${accessDir}`);
  const prev = { ...process.env };
  process.env.FND_MCP_SLIM_DIR = dir;
  process.env.FND_MCP_SLIM_DEBUG = '1';
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  let threw = false;
  try {
    await hooks['tool.execute.before']({ tool }, { args });
  } catch (_) {
    threw = true;
  }
  for (const k of Object.keys(process.env)) if (k.startsWith('FND_')) delete process.env[k];
  for (const [k, v] of Object.entries(prev)) if (k.startsWith('FND_')) process.env[k] = v;
  const log = path.join(dir, 'fnd-mcp-slim-debug.log');
  return { threw, line: fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim() : '' };
}

const aBash = await runAccess('bash', { command: `jq -r '.[0].text' ${SPILL} | head -20` });
assertContains('A1-bash-entry', aBash.line, '"entry":"access"');
assertContains('A2-bash-tool', aBash.line, '"tool":"Bash"');
assertContains('A3-bash-via', aBash.line, '"via":"jq"');
assertContains('A4-bash-spill', aBash.line, `"spill":"${SPILL}"`);

// OpenCode's read/grep tools carry a path argument, so the file-reader side is wired here.
const aRead = await runAccess('read', { filePath: SPILL });
assertContains('A5-read-tool', aRead.line, '"tool":"Read"');
assertContains('A6-read-via', aRead.line, '"via":"Read"');
const aGrep = await runAccess('grep', { pattern: 'error', path: SPILL });
assertContains('A7-grep-tool', aGrep.line, '"tool":"Grep"');
assertContains('A8-grep-via', aGrep.line, '"via":"Grep"');

// The rails: the switch, a command touching no spill, a read with no path, and a BLOCKED command
// (which never ran, so it read nothing) all leave the log absent — and none of them throws.
assertEq('A9-switch', (await runAccess('bash', { command: `jq . ${SPILL}` }, { FND_SPILL_ACCESS: '0' })).line, '');
assertEq('A10-no-spill', (await runAccess('bash', { command: 'npm run lint' })).line, '');
const aNoPath = await runAccess('read', { limit: 20 });
assertEq('A11-read-no-path', aNoPath.line, '');
assertEq('A12-read-no-throw', aNoPath.threw, false);
const aBlocked = await runAccess('bash', { command: 'git commit --no-verify -m "x" /p/tool-results/b1z10evqs.txt' });
assertEq('A13-blocked-not-recorded', aBlocked.line, '');
assertEq('A14-blocked-still-blocks', aBlocked.threw, true);

// P — the declarative backstop --------------------------------------------------------------
const fragmentPath = path.join(ROOT, 'plugins', 'fnd', 'opencode', 'permission-fragment.example.json');
let fragment = null;
try {
  fragment = JSON.parse(fs.readFileSync(fragmentPath, 'utf8'));
  ok();
} catch (e) {
  bad('P01-valid-json', e.message);
}
if (fragment) {
  const globs = Object.keys((fragment.permission && fragment.permission.bash) || {});
  const bash = (fragment.permission && fragment.permission.bash) || {};
  assertEq('P02-default-allow-first', globs[0], '*');
  for (const g of ['*--no-veri*', '*core.hooksPath*', '*HUSKY=0*', 'rm *.husky*', 'rm *.git/hooks*']) {
    assertEq(`P03-deny-${g}`, bash[g], 'deny');
  }
  // Last match wins, so every re-allow of a documented false positive has to sit AFTER the
  // deny it narrows — an ordering swap would silently break legitimate commands.
  const allows = globs.filter((g) => bash[g] === 'allow' && g !== '*');
  const lastDeny = globs.reduce((acc, g, i) => (bash[g] === 'deny' ? i : acc), -1);
  assert('P04-allows-last', allows.every((g) => globs.indexOf(g) > lastDeny), 'a re-allow sits before a deny it must narrow');
  assert('P05-allows-exist', allows.length > 0, 'the fragment re-allows none of the documented false positives');
  // …and each one is an EXACT command, never a prefix pattern: under last-match-wins a trailing
  // `*` swallows the rest of the line, so `chmod +x*` would re-permit
  // `chmod +x .husky/pre-commit && git commit --no-verify` after the denies blocked it.
  const openEnded = allows.filter((g) => /[*?[\]]/.test(g));
  assertEq('P06-allows-anchored', openEnded.join(' '), '');
  // The bypass forms the deny layer exists for must still be denied under that same rule: the
  // LAST matching pattern decides, and no allow may match a line that carries one of them.
  const wild = (glob) => new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 's');
  const verdict = (cmd) => {
    let out = 'allow';
    for (const g of globs) if (wild(g).test(cmd)) out = bash[g];
    return out;
  };
  const fragmentRows = [
    ['deny', 'P07-chained-chmod', 'chmod +x .husky/pre-commit && rm -rf .git/hooks && git commit -m wip --no-verify'],
    ['deny', 'P08-chained-config-get', 'git config --get core.hooksPath && git commit -m wip --no-verify'],
    ['deny', 'P09-plain-no-verify', 'git commit -m wip --no-verify'],
    ['deny', 'P10-husky-env', 'HUSKY=0 git commit -m x'],
    ['deny', 'P11-short-flag', 'git commit -nm wip'],
    // A glob is prefix-anchored, so the deny spellings above only see a flag that comes FIRST.
    // git does not care where it sits: `git commit -m wip -n` is the same bypass, and with only
    // the prefix globs it matched no deny at all and the `*` allow decided it.
    ['deny', 'P11a-trailing-n', 'git commit -m wip -n'],
    ['deny', 'P11b-trailing-n-more', 'git commit -m wip -n --amend'],
    ['deny', 'P11c-trailing-an', 'git commit -m wip -an'],
    ['deny', 'P11d-trailing-na', 'git commit -m wip -na'],
    ['deny', 'P11e-trailing-nm', 'git commit --amend -nm wip'],
    ['deny', 'P11f-trailing-anm', 'git commit --amend -anm wip'],
    ['allow', 'P12-restore-hook', 'chmod +x .husky/pre-commit'],
    ['allow', 'P13-read-hookspath', 'git config --get core.hooksPath'],
    ['allow', 'P14-plain-commit', 'git commit -m "safe change"'],
  ];
  for (const [want, label, cmd] of fragmentRows) assertEq(label, verdict(cmd), want);
}

// M — tool.execute.after (mcp-slim in-place rewrite) ---------------------------------------
async function runAfter(tool, outputText, extra = {}) {
  const output = { title: tool, output: outputText, metadata: { ...extra } };
  await hooks['tool.execute.after']({ tool, sessionID: 'm', callID: 'c2' }, output);
  return output;
}

const rows = [];
for (let i = 0; i < 300; i += 1) {
  rows.push({
    id: i,
    key: `ELC-${i}`,
    summary: 'Same-shape row the array crush can collapse into one spilled table',
    status: 'In Progress',
    assignee: null,
    labels: [],
    description: 'lorem ipsum dolor sit amet consectetur adipiscing elit '.repeat(3),
  });
}
const whale = JSON.stringify({ issues: rows, total: rows.length });
assert('M00-fixture-size', whale.length > 4096, 'fixture must clear the 4 KB size gate');

const compressed = await runAfter('atlassian_searchJiraIssuesUsingJql', whale);
assert('M01-rewritten', compressed.output !== whale, 'output.output was not rewritten');
assert('M02-smaller', compressed.output.length < whale.length, 'rewrite must shrink the result');
assertEq('M03-title-untouched', compressed.title, 'atlassian_searchJiraIssuesUsingJql');
const handle = /full=(\S+)/.exec(compressed.output);
assert('M04-handle', Boolean(handle), 'no full= recovery handle in the rewritten output');
if (handle) assert('M05-spill-exists', fs.existsSync(handle[1]), `spill missing: ${handle[1]}`);

const small = await runAfter('atlassian_getJiraIssue', '{"key":"ELC-1","status":"Done"}');
assertEq('M06-below-gate', small.output, '{"key":"ELC-1","status":"Done"}');

const builtin = await runAfter('bash', whale);
assertEq('M07-builtin-tool', builtin.output, whale);
const noUnderscore = await runAfter('customtool', whale);
assertEq('M08-no-server-prefix', noUnderscore.output, whale);

const objectOutput = { title: 't', output: { content: whale }, metadata: {} };
await hooks['tool.execute.after']({ tool: 'atlassian_searchJiraIssuesUsingJql' }, objectOutput);
assertEq('M09-non-string-output', typeof objectOutput.output, 'object');

// M09b: the shape an MCP tool ACTUALLY arrives in on 1.18.21 — the raw result, no `output` key.
// The whale block is rewritten in place and carries a recovery handle; a sibling error flag survives.
const rawMcp = { content: [{ type: 'text', text: whale }], isError: false };
await hooks['tool.execute.after']({ tool: 'atlassian_searchJiraIssuesUsingJql', sessionID: 'm', callID: 'c3' }, rawMcp);
assert('M09b-raw-mcp-rewritten', rawMcp.content[0].text.length < whale.length, `not rewritten: ${rawMcp.content[0].text.length} B`);
assertContains('M09b-raw-mcp-handle', rawMcp.content[0].text, 'full=');
assertEq('M09b-raw-mcp-flag-kept', rawMcp.isError, false);
const rawSmall = { content: [{ type: 'text', text: '{"ok":true}' }], isError: false };
await hooks['tool.execute.after']({ tool: 'atlassian_atlassianUserInfo', sessionID: 'm', callID: 'c4' }, rawSmall);
assertEq('M09c-raw-mcp-small-untouched', rawSmall.content[0].text, '{"ok":true}');

process.env.FND_MCP_SLIM = '0';
const disabled = await runAfter('atlassian_searchJiraIssuesUsingJql', whale);
assertEq('M10-switch-off', disabled.output, whale);
delete process.env.FND_MCP_SLIM;

// The tool name mcp-slim receives decides how the debug log and `json-slim --report` read, so
// it has to arrive in the cross-host `mcp__server__tool` spelling.
process.env.FND_MCP_SLIM_DEBUG = '1';
const debugDir = path.join(TMP, 'debug');
process.env.FND_MCP_SLIM_DIR = debugDir;
await runAfter('atlassian_searchJiraIssuesUsingJql', whale);
const debugLog = path.join(debugDir, 'fnd-mcp-slim-debug.log');
assert('M11-debug-log', fs.existsSync(debugLog), 'no debug log written');
if (fs.existsSync(debugLog)) {
  const line = fs.readFileSync(debugLog, 'utf8').trim().split('\n').pop();
  assertContains('M12-tool-name', line, '"mcp__atlassian__searchJiraIssuesUsingJql"');
}
delete process.env.FND_MCP_SLIM_DEBUG;
process.env.FND_MCP_SLIM_DIR = path.join(TMP, 'spill');

// C — chat.message (session context + prompt guard) ----------------------------------------
function textPart(text) {
  return { type: 'text', text };
}
async function chat(plugin, parts, sessionID = 'c1', role = 'user') {
  const output = { message: { role, sessionID }, parts };
  await plugin['chat.message']({ sessionID }, output);
  return parts;
}

const themeDir = path.join(TMP, 'theme');
fs.mkdirSync(themeDir, { recursive: true });
fs.writeFileSync(path.join(themeDir, 'shopify.theme.toml'), '[environments.development]\n');
const themePlugin = await newPlugin(themeDir);

const first = await chat(themePlugin, [textPart('what does the live theme use for the hero?')]);
assertContains('C01-store-access', first[0].text, 'live store access');
assertContains('C02-plugin-root', first[0].text, 'fnd plugin root:');
// Statics belong in the user's instructions config on this host — injecting them per message
// would pay for them twice.
assertAbsent('C03-no-statics', first[0].text, 'comment discipline');
assertAbsent('C04-no-lean', first[0].text, 'lean code');

const second = await chat(themePlugin, [textPart('and the footer?')]);
assertAbsent('C05-once-per-session', second[0].text, 'live store access');

const otherSession = await chat(themePlugin, [textPart('new session question')], 'c2');
assertContains('C06-new-session', otherSession[0].text, 'live store access');

await themePlugin.event({ event: { type: 'session.deleted', properties: { sessionID: 'c1' } } });
const afterDelete = await chat(themePlugin, [textPart('back again')], 'c1');
assertContains('C07-after-session-deleted', afterDelete[0].text, 'live store access');

const plainDir = path.join(TMP, 'plain');
fs.mkdirSync(plainDir, { recursive: true });
const plainPlugin = await newPlugin(plainDir);
const plain = await chat(plainPlugin, [textPart('hello')]);
assertEq('C08-no-detection-no-inject', plain[0].text, 'hello');

const assistant = await chat(plainPlugin, [textPart('assistant text')], 'c9', 'assistant');
assertEq('C09-assistant-untouched', assistant[0].text, 'assistant text');

const emptyParts = [];
await chat(plainPlugin, emptyParts, 'c10');
assertEq('C10-empty-parts', emptyParts.length, 0);

// A prompt-JSON block has no analogue here, so the adapter offloads what the guard spilled:
// the blob leaves the message and its bytes stay recoverable from the file.
const blobRows = [];
for (let i = 0; i < 200; i += 1) blobRows.push({ id: i, value: `row-${i}-payload-payload-payload` });
const blob = JSON.stringify({ rows: blobRows });
assert('C11-blob-size', Buffer.byteLength(blob, 'utf8') > 10240, 'fixture must clear both guard gates');
const promptParts = [textPart(`here is the export:\n${blob}\nwhich rows are broken?`)];
await chat(plainPlugin, promptParts, 'c11');
assertAbsent('C12-blob-offloaded', promptParts[0].text, blob.slice(0, 200));
assertContains('C13-handle', promptParts[0].text, '<<fnd-prompt-json full=');
assertContains('C14-prose-kept', promptParts[0].text, 'which rows are broken?');
const spilled = /full=(\S+)/.exec(promptParts[0].text);
if (spilled) {
  assertEq('C15-spill-byte-exact', fs.readFileSync(spilled[1], 'utf8'), blob);
  try { fs.unlinkSync(spilled[1]); } catch (_) {}
} else {
  bad('C15-spill-byte-exact', 'no spill path in the rewritten prompt');
}
// The guard's developer-facing reason describes an erased prompt — it must never be injected.
assertAbsent('C16-reason-not-injected', promptParts[0].text, 'Resubmit your question');

process.env.FND_PROMPT_JSON = '0';
const keptParts = [textPart(`here is the export:\n${blob}\nwhich rows are broken?`)];
await chat(plainPlugin, keptParts, 'c12');
assertContains('C17-switch-off', keptParts[0].text, blob.slice(0, 200));
delete process.env.FND_PROMPT_JSON;

// Both halves off is the manifest's no-spawn short-circuit; the session context still rides.
process.env.FND_PROMPT_JSON = '0';
process.env.FND_CTX_MONITOR = '0';
const gatedPlugin = await newPlugin(themeDir);
const gated = await chat(gatedPlugin, [textPart(`export:\n${blob}`)], 'c13');
assertContains('C18-context-still-injected', gated[0].text, 'live store access');
assertContains('C19-no-guard-run', gated[0].text, blob.slice(0, 200));
delete process.env.FND_PROMPT_JSON;
delete process.env.FND_CTX_MONITOR;

// H — FND_HOST_TRACE, the host-proof log ---------------------------------------------------
// This host has no hook commands to carry the host tag, so the adapter assigns it and records the
// two events it COMPOSES itself; a spawned canonical script writes its own line and must inherit
// the same tag, or the OpenCode column of `doctor --trace` reads `unknown`.
//
// Driven in a CHILD process on purpose: the switch resolves once per process, and every case
// above has already loaded the adapter with it off.
{
  const xdg = path.join(TMP, 'ht-xdg'); // an XDG root with no domaine/env in it
  fs.mkdirSync(xdg, { recursive: true });
  // Same symlink dance as loadModule(): a .js adapter is parsed as ESM only from Node 22.12 on.
  const link = path.join(TMP, 'fnd-plugin.mjs');
  try { fs.symlinkSync(PLUGIN_FILE, link); } catch (_) {}
  const driver = path.join(TMP, 'ht-driver.mjs');
  fs.writeFileSync(driver, [
    "import { pathToFileURL } from 'node:url';",
    "const [, , file, dir, role] = process.argv;",
    "let mod;",
    "try { mod = await import(pathToFileURL(file).href); }",
    `catch (_) { mod = await import(pathToFileURL(${JSON.stringify(link)}).href); }`,
    "const plugin = await mod.FndPlugin({ directory: dir });",
    "const parts = [{ type: 'text', text: 'hello there' }];",
    "await plugin['chat.message']({ sessionID: 'ht1' },",
    "  { message: { role, sessionID: 'ht1' }, parts });",
    "if (role === 'user') await plugin['tool.execute.after']({ tool: 'atlassian_x', sessionID: 'ht1', callID: 'c' },",
    "  { title: 't', output: { content: 'not a string' }, metadata: {} });",
  ].join('\n'));

  const drive = (dir, role = 'user', on = true) => {
    fs.mkdirSync(dir, { recursive: true });
    const env = { ...process.env, XDG_CONFIG_HOME: xdg, FND_MCP_SLIM_DIR: dir };
    delete env.FND_HOST_TRACE;
    delete env.FND_HOST;
    if (on) env.FND_HOST_TRACE = '1';
    spawnSync(process.execPath, [driver, PLUGIN_FILE, themeDir, role], { env, encoding: 'utf8' });
    const log = path.join(dir, 'fnd-host-trace.log');
    return fs.existsSync(log)
      ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
      : [];
  };

  // The adapter's own module-level assignment is what makes every record say `opencode` — its
  // own lines and, through the inherited spawn env, every canonical script's.
  assertEq('H01-host-env', process.env.FND_HOST, 'opencode');

  // First message in a store checkout: the session-context injection is this host's session
  // start, and it gets its own line alongside the chat.message one.
  const lines = drive(path.join(TMP, 'ht-on'));
  const mine = lines.filter((l) => l.hook === 'fnd-plugin');
  const start = mine.find((l) => l.event === 'SessionStart');
  const prompt = mine.find((l) => l.event === 'UserPromptSubmit');
  assert('H02-session-line', Boolean(start), `no SessionStart line: ${JSON.stringify(lines)}`);
  assert('H03-prompt-line', Boolean(prompt), `no UserPromptSubmit line: ${JSON.stringify(lines)}`);
  if (start) {
    assertEq('H04-session-host', start.host, 'opencode');
    assertEq('H05-session-decision', start.decision, 'inject');
    assertEq('H06-session-project', typeof start.project, 'string');
  }
  if (prompt) {
    assertEq('H07-prompt-decision', prompt.decision, 'pass');
    assert('H08-prompt-ms', Number.isInteger(prompt.ms), 'ms must be an integer');
  }
  // Every line the run produced — the adapter's own and any spawned script's — carries the tag
  // the adapter set. A script that lost it would file this host's proof under `unknown`.
  assertEq('H09-all-opencode', lines.filter((l) => l.host !== 'opencode').length, 0);
  // An MCP result this adapter cannot hand to mcp-slim (a non-string output) still leaves a line,
  // or the host proof could not tell a skipped result from a hook the host never called.
  const skipped = mine.find((l) => l.event === 'PostToolUse');
  assert('H09b-after-skip-line', Boolean(skipped), `no PostToolUse line: ${JSON.stringify(lines)}`);
  if (skipped) {
    assertEq('H09c-after-skip-decision', skipped.decision, 'skip');
    assertEq('H09d-after-skip-tool', skipped.tool, 'mcp__atlassian__x');
  }

  // An assistant message is not a turn this adapter acts on — it must not fill the log with lines
  // no hook fired for.
  assertEq('H10-assistant-silent', drive(path.join(TMP, 'ht-assistant'), 'assistant')
    .filter((l) => l.hook === 'fnd-plugin').length, 0);

  // Off is off: no switch, no file.
  assertEq('H11-off-nofile', drive(path.join(TMP, 'ht-off'), 'user', false).length, 0);

  // The spawn env PINS the tag rather than relying on inheritance, so a canonical script keeps
  // reporting the right host even if something upstream cleared it from this process.
  const spawnEnv = fs.readFileSync(PLUGIN_FILE, 'utf8').split('\n')
    .find((l) => l.includes('CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT'));
  assert('H12-spawn-env-line', Boolean(spawnEnv), 'runScript no longer pins the plugin root in its spawn env');
  assertContains('H13-spawn-host-pin', spawnEnv || '', "FND_HOST: 'opencode'");
}

// G-drift — the fast-reject list has three copies and hooks/no-verify-bypass.sh is the single
// source (its `case "$input" in *git*|…` line). This adapter and hooks/cursor-shim.cjs must carry
// a byte-identical literal, so both are extracted and compared rather than pinned to a copy here;
// the third copy, the `case` glob in hooks/hooks-cursor.json, is deliberately coarser and is
// asserted in tests/hooks-cursor-sim.sh instead.
{
  const literal = (file) => {
    const line = fs.readFileSync(file, 'utf8').split('\n').find((l) => l.startsWith('const GIT_TRIGGER = '));
    return line === undefined ? null : line;
  };
  const here = literal(PLUGIN_FILE);
  const cursor = literal(path.join(ROOT, 'plugins', 'fnd', 'hooks', 'cursor-shim.cjs'));
  assert('G40-trigger-opencode', here !== null, 'opencode/fnd-plugin.js has no GIT_TRIGGER literal');
  assert('G40-trigger-cursor', cursor !== null, 'hooks/cursor-shim.cjs has no GIT_TRIGGER literal');
  assertEq('G40-trigger-identical', here, cursor);
}

console.log(`opencode plugin sim: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log(failures.join('\n'));
  process.exit(1);
}
