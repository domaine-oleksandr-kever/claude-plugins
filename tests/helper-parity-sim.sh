#!/usr/bin/env bash
# Helper parity across plugins. Each plugin ships its own copy of a few helpers (a cached plugin
# path is versioned, so one plugin cannot source another's), and a fix that lands in one copy only
# goes stale in the rest. This suite fails when the copies drift:
#   a. every plugins/<p>/scripts/doctor.cjs (fnd aside) carries the same body of out, usage,
#      parseArgs, readJson, checkNode, enabledPlugins, newestSessionDir and installedPlugin (the
#      `const found = …;` record it returns may carry extra fields);
#   b. checkEventLog is the same in every team plugin's doctor.cjs once the plugin's own name
#      (`fe`, `FE_`) is read as a placeholder;
#   c. fe's _shopify-common.sh carries base's _common.sh bodies of trim_ws and dotenv_value.
# The checker runs against a planted drift first, so a rule that stopped firing fails here.
# Exit 0 = all green.
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="$(command -v node || true)"
[ -n "$NODE_BIN" ] || { echo "helper-parity-sim: node not found"; exit 1; }
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

pass=0; fail=0; failures=""
ok() { pass=$((pass + 1)); }
bad() { fail=$((fail + 1)); failures="${failures}  [$1] $2
"; }

CHECK="$TMP/check.cjs"
cat > "$CHECK" <<'JS'
'use strict';
const fs = require('fs');
const path = require('path');
const root = process.argv[2];
const out = [];
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const jsBody = (src, name) => (new RegExp(`^(?:async )?function ${name}\\([^]*?^\\}`, 'm').exec(src) || [])[0] || null;
const shBody = (src, name) => (new RegExp(`^${name}\\(\\)[^]*?^\\}`, 'm').exec(src) || [])[0] || null;
const manifest = (p) => { try { return JSON.parse(read(path.join(root, 'plugins', p, '.claude-plugin', 'plugin.json'))); } catch { return {}; } };

const doctors = fs.readdirSync(path.join(root, 'plugins')).sort()
  .filter((p) => p !== 'fnd' && fs.existsSync(path.join(root, 'plugins', p, 'scripts', 'doctor.cjs')))
  .map((p) => ({ p, src: read(path.join(root, 'plugins', p, 'scripts', 'doctor.cjs')) }));
const same = (rule, name, copies) => {
  const [first, ...rest] = copies;
  if (!first) return;
  for (const c of [first, ...rest]) if (c.body === null) out.push(`${rule}\t${c.p}\t${name} missing`);
  for (const c of rest) if (c.body !== null && first.body !== null && c.body !== first.body) out.push(`${rule}\t${c.p}\t${name} differs from ${first.p}`);
};
for (const name of ['out', 'usage', 'parseArgs', 'readJson', 'checkNode', 'enabledPlugins', 'newestSessionDir']) {
  same('a', name, doctors.map(({ p, src }) => ({ p, body: jsBody(src, name) })));
}
same('a', 'installedPlugin', doctors.map(({ p, src }) => {
  const b = jsBody(src, 'installedPlugin');
  return { p, body: b && b.replace(/const found = [^;]*;/, 'const found = …;') };
}));
const team = doctors.filter(({ p }) => JSON.stringify(manifest(p).dependencies) === '["base"]');
same('b', 'checkEventLog', team.map(({ p, src }) => {
  const b = jsBody(src, 'checkEventLog');
  const up = p.toUpperCase().replace(/-/g, '_');
  return { p, body: b && b.split(`${up}_`).join('<P>_').replace(new RegExp(`\\b${p}\\b`, 'g'), '<p>') };
}));
const base = read(path.join(root, 'plugins', 'base', 'scripts', '_common.sh')) || '';
const shop = read(path.join(root, 'plugins', 'fe', 'scripts', '_shopify-common.sh'));
if (shop !== null) {
  for (const name of ['trim_ws', 'dotenv_value']) {
    same('c', name, [{ p: 'base', body: shBody(base, name) }, { p: 'fe', body: shBody(shop, name) }]);
  }
}
process.stdout.write(out.join('\n') + (out.length ? '\n' : ''));
JS

# ---------------------------------------------------------- the checker fires on a planted drift --
FX="$TMP/fx"
mkdir -p "$FX/plugins"
for p in base fe qa; do
  if [ -d "$ROOT/plugins/$p" ]; then
    mkdir -p "$FX/plugins/$p/scripts" "$FX/plugins/$p/.claude-plugin"
    cp "$ROOT/plugins/$p/.claude-plugin/plugin.json" "$FX/plugins/$p/.claude-plugin/"
    cp "$ROOT/plugins/$p/scripts/doctor.cjs" "$FX/plugins/$p/scripts/"
  fi
done
cp "$ROOT/plugins/base/scripts/_common.sh" "$FX/plugins/base/scripts/"
cp "$ROOT/plugins/fe/scripts/_shopify-common.sh" "$FX/plugins/fe/scripts/"
"$NODE_BIN" "$CHECK" "$FX" > "$TMP/clean.out"
if [ ! -s "$TMP/clean.out" ]; then ok; else bad fixture-clean "the copied plugins already drift: $(tr '\n' ';' < "$TMP/clean.out")"; fi
"$NODE_BIN" -e '
  const fs = require("fs"); const [dir] = process.argv.slice(1);
  const edit = (f, a, b) => { const s = fs.readFileSync(f, "utf8"); if (!s.includes(a)) throw new Error(f + ": " + a); fs.writeFileSync(f, s.replace(a, b)); };
  edit(dir + "/plugins/qa/scripts/doctor.cjs", "function readJson(file) {", "function readJson(file) {\n  void 0;");
  edit(dir + "/plugins/fe/scripts/doctor.cjs", "function checkEventLog(", "function checkEventLog_gone(");
  edit(dir + "/plugins/qa/scripts/doctor.cjs", "const found = {", "const found = { extra: 1,");
  edit(dir + "/plugins/fe/scripts/_shopify-common.sh", "dotenv_value() {", "dotenv_value() {\n  :");
' "$FX"
"$NODE_BIN" "$CHECK" "$FX" > "$TMP/fx.out"
want() { # want <rule> <plugin> <what>
  if awk -F'\t' -v r="$1" -v p="$2" -v w="$3" '$1 == r && $2 == p && $3 == w { f = 1 } END { exit !f }' "$TMP/fx.out"; then ok
  else bad "fixture-$1" "rule $1 did not flag '$2 $3': $(tr '\n' ';' < "$TMP/fx.out")"; fi
}
want a qa "readJson differs from base"
want b fe "checkEventLog missing"
want c fe "dotenv_value differs from base"
if ! grep -q 'installedPlugin' "$TMP/fx.out"; then ok; else bad fixture-a-found "an extra field in the found record was flagged"; fi

# ------------------------------------------------------------------------------- the real plugins --
"$NODE_BIN" "$CHECK" "$ROOT" > "$TMP/real.out"
for r in a b c; do
  hits="$(awk -F'\t' -v r="$r" '$1 == r { printf "%s: %s; ", $2, $3 }' "$TMP/real.out")"
  if [ -z "$hits" ]; then ok; else bad "parity-$r" "$hits"; fi
done

echo "helper-parity-sim: $pass passed, $fail failed"
if [ "$fail" -gt 0 ]; then printf '%s' "$failures"; exit 1; fi
