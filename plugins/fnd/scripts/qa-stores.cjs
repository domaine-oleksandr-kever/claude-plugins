#!/usr/bin/env node
// qa-stores — the QA store registry: which storefronts a QA engineer tests, how to unlock each
// one, and which theme id is the one under test.
//
// One JSON file per machine, `~/.config/domaine/qa-stores.json` (dir 0700, file 0600, never in a
// repo and never in a task workspace). Shape:
//
//   {"version":1,"stores":{"<domain>":{"alias":"MAC US UAT","password":"…",
//     "themes":{"<id>":"<label>"},"defaultTheme":"<id>","notes":"free text",
//     "updatedAt":"<ISO>"}}}
//
// It carries the STOREFRONT password (the "coming soon" gate a QA run has to pass), so the file is
// a secret: `get` is the only command that prints one — `list`, `find` and `set` mask it as `***`,
// and no message quotes an operator-supplied value back, so a password typed into the wrong
// argument position never reaches stderr or a session log.
// Writes go through a 0600 stage file and a rename, so a reader never sees a half-written registry,
// and the whole load→patch→save of `set`/`unset` runs under an exclusive `<file>.lock`, so two runs
// in two worktrees cannot each save a snapshot taken before the other's store existed. A file this
// script cannot parse is reported (exit 3) and left exactly as it is: a hand-edited registry with a
// typo is recoverable, an overwritten one is not. A hand-edited leaf of the wrong type (an unquoted
// numeric theme id) still renders — display stringifies every cell.
//
// `<store>` resolves against the exact domain OR the exact alias (case-insensitive); a domain is
// normalized first (scheme, userinfo, port, path and trailing dots dropped, lowercased), so
// `https://elc-us-mc-uat.myshopify.com/` and `elc-us-mc-uat.myshopify.com` are one entry. `set`
// takes a host only: an alias in the `<domain>` position is refused (exit 2) instead of creating a
// second entry keyed by the alias text, and an `--alias` another domain already carries is refused
// too — a reused alias would hand out the wrong store's password.
//
// `set` merges: `themes` accumulate (a repeated `--theme <id>` without `:<label>` keeps the label
// it already has), every other flag overwrites, and an omitted flag leaves its field alone — so
// `set <domain> --theme <id>` never drops the stored password. `--password ''` is how a store with
// an open storefront is recorded: the field is dropped, so every reader sees "no password" the same
// way. Flags may come in any order, and a value is taken VERBATIM from argv: storefront passwords
// carry `$`, backticks, spaces and quotes.
//
// Exit: 0 ok · 1 no such store (or an ambiguous alias) · 2 usage · 3 the registry is unreadable,
// unparsable, unlockable or a version this script does not know (nothing is written).
//
// Usage:
//   qa-stores.cjs list [--json]
//   qa-stores.cjs get <store>
//   qa-stores.cjs find <text>
//   qa-stores.cjs set <domain> [--alias <a>] [--password <p>] [--theme <id>[:<label>]]…
//                              [--default-theme <id>] [--note <text>]
//   qa-stores.cjs unset <store>
//   qa-stores.cjs path
// <store> = exact domain or exact alias (case-insensitive). Only `get` prints the password.
// `--help` / `-h` (outside a flag value) prints this block and exits 0, before any file access.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// The `// Usage:` block above, verbatim — the header is the contract a reader lands on, this is
// what `--help` prints; tests/qa-stores-sim.sh pins the two together.
const USAGE = `Usage:
  qa-stores.cjs list [--json]
  qa-stores.cjs get <store>
  qa-stores.cjs find <text>
  qa-stores.cjs set <domain> [--alias <a>] [--password <p>] [--theme <id>[:<label>]]…
                             [--default-theme <id>] [--note <text>]
  qa-stores.cjs unset <store>
  qa-stores.cjs path
<store> = exact domain or exact alias (case-insensitive). Only \`get\` prints the password.
\`--help\` / \`-h\` (outside a flag value) prints this block and exits 0, before any file access.`;

// A reader that goes away mid-write (`list | head -1`) is success, not failure: the EPIPE
// (Windows: `code: 'EOF'`) surfaces async and would otherwise crash the process after the consumer
// already got its bytes. CLI-only file — nothing require()s it.
const quietOnEpipe = (s) => s.on('error', (e) => {
  if (e && (e.code === 'EPIPE' || e.code === 'EOF')) process.exit(0);
  throw e;
});
quietOnEpipe(process.stdout);
quietOnEpipe(process.stderr);

const MASK = '***';
const ORDER = ['alias', 'password', 'themes', 'defaultTheme', 'notes', 'updatedAt'];
const VALUE_FLAGS = ['--alias', '--password', '--theme', '--default-theme', '--note'];
const LOCK_WAIT_MS = 10000;
const LOCK_STALE_MS = 30000;

// process.exit skips a finally block, and every refusal path here exits — so the held lock is
// released from an exit handler instead
let heldLock = null;
process.on('exit', () => {
  if (heldLock) {
    try { fs.unlinkSync(heldLock); } catch (_) {}
    heldLock = null;
  }
});

function registryPath() {
  return path.join(os.homedir(), '.config', 'domaine', 'qa-stores.json');
}

function die(msg, code) {
  process.stderr.write('qa-stores: ' + msg + '\n');
  process.exit(code);
}

function usage(msg) {
  process.stderr.write('qa-stores: ' + msg + '\n' + USAGE + '\n');
  process.exit(2);
}

function corrupt(msg) {
  die(msg + ' — fix or move the file; nothing was written', 3);
}

// scheme, userinfo, port, path, query and fragment are call decoration, not identity: the registry
// key is the host, so one store pasted in any shape stays one entry
function normalizeDomain(input, what) {
  let d = String(input == null ? '' : input).trim();
  d = d.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '');
  d = d.replace(/[/?#].*$/, '');
  d = d.replace(/^[^@]*@/, '').replace(/:\d+$/, '');
  d = d.replace(/\.+$/, '').toLowerCase();
  if (!d) usage(what + ' does not name a store domain');
  return d;
}

function ensureDir(dir) {
  // recursive mkdir is a no-op on an existing dir, and the mode option only applies to dirs it
  // creates — so the chmod runs unconditionally: domaine-env.cjs may have made this dir 0755
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch (e) {
    if (e.code !== 'EPERM' && e.code !== 'ENOTSUP') throw e;
  }
}

const sleepMs = (ms) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

// Serializes load→patch→save. The stage-and-rename below makes one write atomic but does not
// serialize a read-modify-write: without this, the later of two concurrent `set` runs saves a
// snapshot taken before the earlier one's store existed and silently drops it.
function withLock(fn) {
  const file = registryPath();
  const lock = file + '.lock';
  ensureDir(path.dirname(file));
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.closeSync(fs.openSync(lock, 'wx', 0o600));
      heldLock = lock;
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') die('cannot lock ' + file + ' (' + (e.code || e.message) + ')', 3);
      let age = 0;
      try { age = Date.now() - fs.statSync(lock).mtimeMs; } catch (_) { continue; }
      if (age > LOCK_STALE_MS) {
        try { fs.unlinkSync(lock); } catch (_) {}
        continue;
      }
      if (Date.now() >= deadline) {
        die('another qa-stores run holds ' + lock + ' — remove it if no run is in flight', 3);
      }
      sleepMs(20);
    }
  }
  try {
    return fn();
  } finally {
    if (heldLock) {
      try { fs.unlinkSync(heldLock); } catch (_) {}
      heldLock = null;
    }
  }
}

function loadRegistry() {
  const file = registryPath();
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { version: 1, stores: {} };
    corrupt('cannot read ' + file + ' (' + (e.code || e.message) + ')');
  }
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    corrupt(file + ' is not valid JSON (' + e.message + ')');
  }
  const plain = (v) => v && typeof v === 'object' && !Array.isArray(v);
  if (!plain(obj)) corrupt(file + ' is not a registry object');
  if (obj.version !== 1) {
    corrupt(file + ' has version ' + JSON.stringify(obj.version) + ', which this script does not know');
  }
  if (!plain(obj.stores)) corrupt(file + ' has no "stores" object');
  for (const [domain, store] of Object.entries(obj.stores)) {
    if (!plain(store)) corrupt(file + ': store "' + domain + '" is not an object');
    if (store.themes !== undefined && !plain(store.themes)) {
      corrupt(file + ': store "' + domain + '" has a "themes" value that is not an object');
    }
  }
  return obj;
}

function saveRegistry(reg) {
  const file = registryPath();
  const dir = path.dirname(file);
  const stores = {};
  for (const [domain, store] of Object.entries(reg.stores)) stores[domain] = ordered(store);
  const body = JSON.stringify({ version: 1, stores }, null, 2) + '\n';
  const tmp = path.join(dir, '.' + path.basename(file) + '.tmp-' + process.pid);
  try {
    ensureDir(dir);
    // mode on writeFileSync applies to a file it creates; chmod covers a stage file left by a
    // crashed run, whose mode would otherwise survive the rename
    fs.writeFileSync(tmp, body, { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    die('cannot write ' + file + ' (' + (e.code || e.message) + ')', 3);
  }
}

function ordered(store) {
  const out = {};
  for (const k of ORDER) if (store[k] !== undefined) out[k] = store[k];
  for (const k of Object.keys(store)) if (!(k in out)) out[k] = store[k];
  return out;
}

function withDomain(domain, store) {
  return Object.assign({ domain }, ordered(store));
}

function masked(domain, store) {
  const out = withDomain(domain, store);
  if (out.password !== undefined) out.password = MASK;
  return out;
}

const aliasKey = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : null);

// exact domain first, then exact alias — a selector that matches both is the same store anyway.
// A hand-edited registry can carry the same alias twice; picking the first would hand out one
// store's password under the other's name, so it is an error instead.
function resolve(reg, selector) {
  const domain = normalizeDomain(selector, 'the store selector');
  if (Object.prototype.hasOwnProperty.call(reg.stores, domain)) return domain;
  const wanted = aliasKey(selector);
  const hits = Object.entries(reg.stores)
    .filter(([, store]) => aliasKey(store.alias) !== null && aliasKey(store.alias) === wanted)
    .map(([key]) => key);
  if (hits.length > 1) {
    die('alias matches ' + hits.length + ' stores (' + hits.join(', ') + ') — name the domain', 1);
  }
  return hits.length ? hits[0] : null;
}

function print(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

function cmdList(rest) {
  let json = false;
  for (const a of rest) {
    if (a === '--json') json = true;
    else if (a.startsWith('-')) usage('unknown option ' + a + ' for list');
    else usage('list takes no argument');
  }
  const reg = loadRegistry();
  const rows = Object.entries(reg.stores);
  if (json) {
    print(rows.map(([domain, store]) => masked(domain, store)));
    return;
  }
  process.stdout.write('registry: ' + registryPath() + '\n');
  if (!rows.length) {
    process.stdout.write('(no stores registered — qa-stores.cjs set <domain> --alias <a> --password <p>)\n');
    return;
  }
  // a hand-edited registry can hold a number where a string belongs (an unquoted theme id is the
  // natural way to type one) — the table stringifies rather than crashing on it
  const cell = (v) => (v === undefined || v === null || v === '' ? '-' : String(v));
  const cells = rows.map(([domain, store]) => [
    cell(domain),
    cell(store.alias),
    cell(store.defaultTheme),
    cell(Object.keys(store.themes || {}).length),
    store.password === undefined ? '-' : MASK,
  ]);
  const head = ['DOMAIN', 'ALIAS', 'DEFAULT THEME', 'THEMES', 'PASSWORD'];
  const width = head.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i].length)));
  const line = (c) => c.map((v, i) => (i === c.length - 1 ? v : v.padEnd(width[i]))).join('  ') + '\n';
  process.stdout.write(line(head));
  for (const c of cells) process.stdout.write(line(c));
}

function cmdGet(rest) {
  if (rest.length !== 1) usage('get expects one <store>');
  const reg = loadRegistry();
  const domain = resolve(reg, rest[0]);
  if (!domain) die('no store matches that selector (qa-stores.cjs list)', 1);
  print(withDomain(domain, reg.stores[domain]));
}

function cmdFind(rest) {
  if (rest.length !== 1) usage('find expects one <text>');
  const needle = String(rest[0]).trim().toLowerCase();
  if (!needle) usage('find expects a non-empty <text>');
  const reg = loadRegistry();
  const hits = Object.entries(reg.stores).filter(([domain, store]) => {
    const hay = [domain, store.alias, store.notes].filter((v) => typeof v === 'string');
    return hay.some((v) => v.toLowerCase().includes(needle));
  });
  print(hits.map(([domain, store]) => masked(domain, store)));
}

function cmdSet(rest) {
  let domain = null;
  let clearPassword = false;
  const themes = [];
  const patch = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (VALUE_FLAGS.includes(a)) {
      const v = rest[i + 1];
      if (v === undefined) usage(a + ' needs a value');
      i++;
      if (a === '--alias') patch.alias = v;
      // `--password ''` is the documented way to record an open storefront
      else if (a === '--password') { if (v === '') clearPassword = true; else patch.password = v; }
      else if (a === '--note') patch.notes = v;
      else if (a === '--default-theme') patch.defaultTheme = v;
      else {
        const c = v.indexOf(':');
        const id = (c < 0 ? v : v.slice(0, c)).trim();
        if (!id) usage('--theme needs <id>[:<label>]');
        themes.push([id, c < 0 ? undefined : v.slice(c + 1)]);
      }
    } else if (a.startsWith('-')) usage('unknown option ' + a + ' for set');
    else if (domain === null) domain = normalizeDomain(a, 'the <domain> argument');
    // the offending value is NOT quoted back: a forgotten `--password` puts the secret here
    else usage('set takes one <domain> (got a second argument)');
  }
  if (domain === null) usage('set expects <domain>');
  // the key space is hosts only, so `set <alias>` cannot fork a second, password-less entry that
  // then wins alias resolution
  if (/\s/.test(domain) || !domain.includes('.')) {
    usage('the <domain> argument must be a store host (elc-us-mc-uat.myshopify.com), not an alias');
  }
  withLock(() => {
    const reg = loadRegistry();
    const known = Object.prototype.hasOwnProperty.call(reg.stores, domain);
    for (const [key, store] of Object.entries(reg.stores)) {
      if (!known && aliasKey(store.alias) === domain) {
        usage('"' + domain + '" is the alias of ' + key + ' — pass that domain as <domain>');
      }
      if (patch.alias !== undefined && key !== domain && aliasKey(store.alias) === aliasKey(patch.alias)) {
        usage('--alias is already on ' + key + ' — an alias names one store');
      }
    }
    const store = Object.assign({}, reg.stores[domain]);
    Object.assign(store, patch);
    // an open storefront is "no password", never an empty one: `list`, `list --json` and `get` then
    // agree, and the skill reports a missing credential instead of submitting ''
    if (clearPassword || store.password === '') delete store.password;
    if (themes.length) {
      const merged = Object.assign({}, store.themes);
      // a bare `--theme <id>` re-registers the id without claiming to know its label
      for (const [id, label] of themes) merged[id] = label === undefined ? (merged[id] || '') : label;
      store.themes = merged;
    }
    store.updatedAt = new Date().toISOString();
    reg.stores[domain] = store;
    saveRegistry(reg);
    print(masked(domain, store));
  });
}

function cmdUnset(rest) {
  if (rest.length !== 1) usage('unset expects one <store>');
  withLock(() => {
    const reg = loadRegistry();
    const domain = resolve(reg, rest[0]);
    if (!domain) die('no store matches that selector (qa-stores.cjs list)', 1);
    delete reg.stores[domain];
    saveRegistry(reg);
    process.stdout.write('removed ' + domain + '\n');
  });
}

const args = process.argv.slice(2);
// a `-h` sitting in a flag's value position is that flag's value, not a usage question
if (args.some((a, i) => (a === '--help' || a === '-h') && !VALUE_FLAGS.includes(args[i - 1]))) {
  process.stdout.write(USAGE + '\nFull contract: the header of ' + __filename + '\n');
  process.exit(0);
}

const cmd = args[0] || 'list';
const rest = args.slice(1);
if (cmd === 'list') cmdList(rest);
else if (cmd === 'get') cmdGet(rest);
else if (cmd === 'find') cmdFind(rest);
else if (cmd === 'set') cmdSet(rest);
else if (cmd === 'unset') cmdUnset(rest);
else if (cmd === 'path') {
  if (rest.length) usage('path takes no argument');
  process.stdout.write(registryPath() + '\n');
} else usage('unknown command "' + cmd + '" (use list|get|find|set|unset|path)');
