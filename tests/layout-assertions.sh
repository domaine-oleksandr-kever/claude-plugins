#!/usr/bin/env bash
# Layout + version-sync assertions for the multi-harness packaging (M2).
# Every per-host manifest under plugins/fnd/.*-plugin/ must parse, carry the canonical
# plugin name, and stamp the SAME version as the Claude Code manifest (the version stamp
# is the cache-invalidation mechanism on the version-cache hosts — drift there reads as
# "nothing to update"). Every root marketplace file must resolve to a plugin dir that
# exists and holds a manifest. Manifest paths stay relative with no `..` (host loaders
# refuse to escape the plugin root).
# Discovery is by glob, so a host manifest added later is covered without editing this file.
# Exit 0 = layout green.
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN_DIR="$ROOT/plugins/fnd"
CANON="$PLUGIN_DIR/.claude-plugin/plugin.json"
CURSOR_MANIFEST="$PLUGIN_DIR/.cursor-plugin/plugin.json"
CODEX_MANIFEST="$PLUGIN_DIR/.codex-plugin/plugin.json"
NODE_BIN="$(command -v node)"

pass=0; fail=0; failures=""
ok() { pass=$((pass + 1)); }
bad() { fail=$((fail + 1)); failures="${failures}  [$1] $2
"; }

# jval <file> <dotted.path> — scalar at that path, empty string when absent or unparseable
jval() {
  "$NODE_BIN" -e '
    const fs = require("fs");
    let m;
    try { m = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch (e) { process.exit(1); }
    let v = m;
    for (const k of process.argv[2].split(".")) {
      if (v === null || typeof v !== "object") { v = undefined; break; }
      v = v[k];
    }
    process.stdout.write(v === undefined || v === null ? "" : String(v));
  ' "$1" "$2" 2>/dev/null
}

# jsources <file> — one `name<TAB>source` row per marketplace plugin entry
jsources() {
  "$NODE_BIN" -e '
    const fs = require("fs");
    let m;
    try { m = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch (e) { process.exit(1); }
    for (const p of m.plugins || []) process.stdout.write(`${p.name}\t${p.source}\n`);
  ' "$1" 2>/dev/null
}

parses() { "$NODE_BIN" -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$1" 2>/dev/null; }

# ------------------------------------------------------------------ required files --
# Every packaging and install-path file is listed here BY NAME: the per-host blocks below are
# guarded on existence, so without this list a deleted manifest would take its own assertions
# with it — and a bundled script deleted with its suite would leave nothing red anywhere.
for f in "$CANON" \
         "$ROOT/.claude-plugin/marketplace.json" \
         "$CURSOR_MANIFEST" \
         "$ROOT/.cursor-plugin/marketplace.json" \
         "$CODEX_MANIFEST" \
         "$ROOT/scripts/install.sh" \
         "$ROOT/scripts/bootstrap.sh" \
         "$PLUGIN_DIR/scripts/doctor.cjs" \
         "$PLUGIN_DIR/scripts/bump-version.cjs" \
         "$PLUGIN_DIR/scripts/opencode-config.cjs" \
         "$ROOT/tests/opencode-config-sim.sh"; do
  if [ -f "$f" ]; then ok; else bad "exists-${f#$ROOT/}" "missing"; fi
done

# Both entry scripts are documented as `./scripts/<name>.sh`, so the mode bit git carries is part
# of the packaging: a lost +x turns a documented install command into "permission denied".
for f in "$ROOT/scripts/install.sh" "$ROOT/scripts/bootstrap.sh"; do
  if [ -x "$f" ]; then ok; else bad "executable-${f#$ROOT/}" "not executable — './${f#$ROOT/}' would fail"; fi
done

CANON_VERSION="$(jval "$CANON" version)"
case "$CANON_VERSION" in
  [0-9]*.[0-9]*.[0-9]*) ok ;;
  *) bad canon-version "canonical version not semver: '$CANON_VERSION'" ;;
esac

# the README carries the same stamp bump-version.cjs owns; a drift here documents a release
# that never happened
README_VER="$(grep -o 'fnd v[0-9][0-9.]*' "$ROOT/README.md" 2>/dev/null | head -1 | sed 's/^fnd v//')"
if [ -n "$README_VER" ]; then
  if [ "$README_VER" = "$CANON_VERSION" ]; then ok
  else bad readme-version "README 'fnd v$README_VER' != canonical '$CANON_VERSION'"; fi
else
  bad readme-version "no 'fnd v<semver>' marker in README.md — bump-version.cjs would skip it"
fi

# ------------------------------------------- every host manifest: parse, name, version --
found_hosts=0
for d in "$PLUGIN_DIR"/.*-plugin; do
  [ -d "$d" ] || continue
  m="$d/plugin.json"
  host="$(basename "$d")"
  [ -f "$m" ] || { bad "manifest-$host" "no plugin.json in $host"; continue; }
  found_hosts=$((found_hosts + 1))
  if parses "$m"; then ok; else bad "parse-$host" "not valid JSON"; continue; fi
  n="$(jval "$m" name)"
  if [ "$n" = fnd ]; then ok; else bad "name-$host" "name is '$n', want 'fnd'"; fi
  v="$(jval "$m" version)"
  if [ "$v" = "$CANON_VERSION" ]; then ok
  else bad "version-$host" "version '$v' != canonical '$CANON_VERSION'"; fi
done
if [ "$found_hosts" -ge 3 ]; then ok
else bad host-manifest-count "found $found_hosts host manifests, want canonical + Cursor + Codex"; fi

# ------------------------------------------------- root marketplaces resolve to a plugin --
for mk in "$ROOT"/.*-plugin/marketplace.json; do
  [ -f "$mk" ] || continue
  label="$(basename "$(dirname "$mk")")"
  if parses "$mk"; then ok; else bad "parse-marketplace-$label" "not valid JSON"; continue; fi
  rows="$(jsources "$mk")"
  if [ -n "$rows" ]; then ok; else bad "marketplace-$label" "no plugin entries"; continue; fi
  saw_fnd=no
  while IFS="$(printf '\t')" read -r name src; do
    [ -n "$name" ] || continue
    [ "$name" = fnd ] && saw_fnd=yes
    case "$src" in
      /*|*..*) bad "source-$label-$name" "source must be relative and free of '..': '$src'" ;;
      *) ok ;;
    esac
    target="$ROOT/${src#./}"
    if [ -d "$target" ]; then ok; else bad "source-$label-$name" "source dir does not exist: '$src'"; continue; fi
    # a marketplace source is only installable if the dir carries a manifest for SOME host
    if ls "$target"/.*-plugin/plugin.json >/dev/null 2>&1; then ok
    else bad "source-$label-$name" "no */plugin.json under '$src'"; fi
  done <<EOF
$rows
EOF
  if [ "$saw_fnd" = yes ]; then ok; else bad "marketplace-$label" "no 'fnd' plugin entry"; fi
done

# --------------------------------------------------------- Cursor manifest pointers --
if [ -f "$CURSOR_MANIFEST" ]; then
  # skills/ is auto-discovered but pinned explicitly so the canonical dir is never
  # shadowed by a host default; agents point at the generated per-host tree (M4). Nothing
  # sitting at its auto-discovered default (mcp.json) is re-declared — an unvalidated key
  # in a 2.5 manifest is a load-time risk with no upside.
  for pair in "skills:skills/" "agents:agents-cursor/" "hooks:hooks/hooks-cursor.json"; do
    key="${pair%%:*}"; want="${pair#*:}"
    got="$(jval "$CURSOR_MANIFEST" "$key")"
    if [ "$got" = "$want" ]; then ok; else bad "cursor-$key" "'$got' != '$want'"; fi
    case "$got" in
      /*|*..*) bad "cursor-$key" "pointer must be relative and free of '..': '$got'" ;;
      *) ok ;;
    esac
  done
  # the pointed-at agents tree is generated in M4 and the wiring files in M5/M6; only the
  # canonical skills dir has to be real today
  if [ -d "$PLUGIN_DIR/skills" ]; then ok; else bad cursor-skills-dir "plugins/fnd/skills missing"; fi

  for k in displayName description license; do
    if [ -n "$(jval "$CURSOR_MANIFEST" "$k")" ]; then ok; else bad "cursor-$k" "empty or absent"; fi
  done
  for k in author.name author.email; do
    a="$(jval "$CURSOR_MANIFEST" "$k")"
    c="$(jval "$CANON" "$k")"
    if [ "$a" = "$c" ]; then ok; else bad "cursor-$k" "'$a' != canonical '$c'"; fi
  done
  # Cursor gets its MCP list from the generated mcp.json — the canonical server list must
  # not be duplicated into a second hand-edited home
  if [ -z "$(jval "$CURSOR_MANIFEST" mcpServers)" ]; then ok
  else bad cursor-mcpservers "mcpServers duplicated into the Cursor manifest"; fi
  if [ -z "$(jval "$CURSOR_MANIFEST" mcp)" ]; then ok
  else bad cursor-mcp-key "mcp/ is auto-discovered — do not re-declare it in the manifest"; fi
fi

# ---------------------------------------------------------- Codex manifest pointers --
if [ -f "$CODEX_MANIFEST" ]; then
  # Codex loads skills, hook wiring and MCP servers through path pointers; the wiring and
  # MCP files themselves are generated in M5/M6, so only the paths are asserted today.
  for pair in "skills:./skills/" "hooks:./hooks/hooks-codex.json" "mcpServers:./mcp-codex.json"; do
    key="${pair%%:*}"; want="${pair#*:}"
    got="$(jval "$CODEX_MANIFEST" "$key")"
    if [ "$got" = "$want" ]; then ok; else bad "codex-$key" "'$got' != '$want'"; fi
    case "$got" in
      /*|~*|*..*) bad "codex-$key" "pointer must be relative and free of '..': '$got'" ;;
      *) ok ;;
    esac
  done
  # a copied inline `hooks` / `mcpServers` block would be silently ignored by the pointer
  # loader, and would fork the canonical server list into a second hand-edited home
  for k in skills hooks mcpServers; do
    case "$(jval "$CODEX_MANIFEST" "$k")" in
      "[object Object]") bad "codex-$k" "pointer is an inline object, want a path string" ;;
      *) ok ;;
    esac
  done
  if [ -d "$PLUGIN_DIR/skills" ]; then ok; else bad codex-skills-dir "plugins/fnd/skills missing"; fi
  # A per-host generated file may not squat on a CLAUDE CODE component path. `.mcp.json` at the
  # plugin root is one: Claude Code's loader reads it in addition to the canonical manifest's
  # mcpServers block, so a Codex-targeted file would quietly change what Claude Code loads.
  if [ -e "$PLUGIN_DIR/.mcp.json" ]; then
    bad codex-mcp-collision "plugins/fnd/.mcp.json collides with Claude Code's own plugin MCP component"
  else ok; fi

  if [ -n "$(jval "$CODEX_MANIFEST" description)" ]; then ok; else bad codex-description "empty or absent"; fi
  for k in author.name author.email license; do
    a="$(jval "$CODEX_MANIFEST" "$k")"
    c="$(jval "$CANON" "$k")"
    if [ "$a" = "$c" ]; then ok; else bad "codex-$k" "'$a' != canonical '$c'"; fi
  done

  # interface block: what the /plugins browser shows and the prompts it seeds
  if [ -n "$(jval "$CODEX_MANIFEST" interface.displayName)" ]; then ok
  else bad codex-interface-displayname "empty or absent"; fi
  n_prompts="$(jval "$CODEX_MANIFEST" interface.defaultPrompts.length)"
  case "$n_prompts" in
    [2-9]|[1-9][0-9]) ok ;;
    *) bad codex-interface-prompts "want 2+ defaultPrompts, got '$n_prompts'" ;;
  esac
  i=0
  while [ "$i" -lt "${n_prompts:-0}" ]; do
    p="$(jval "$CODEX_MANIFEST" "interface.defaultPrompts.$i")"
    i=$((i + 1))
    # Codex invokes skills as `$name`, not Claude Code's `/name`
    case "$p" in
      \$[a-z0-9-]*) ok ;;
      *) bad "codex-interface-prompt-$i" "must start with \$skill-name: '$p'"; continue ;;
    esac
    s="${p#$}"; s="${s%% *}"
    if [ -f "$PLUGIN_DIR/skills/$s/SKILL.md" ]; then ok
    else bad "codex-interface-prompt-$i" "unknown skill '$s'"; fi
  done
fi

# ------------------------------------ every session convention reaches every host --
# plugins/fnd/hooks/*.md IS the set of session conventions, and each host delivers it from its own
# hardcoded wiring — except OpenCode, whose paste is derived from the directory itself. Without
# this row a new convention file reaches OpenCode alone, and a stray .md dropped into hooks/
# reaches OpenCode users as an instruction nobody wired.
# store-access.md is the exception on Cursor only: the shim injects it where store credentials are
# detected instead of shipping it as an always-applied rule.
CURSOR_SHIM_INJECTED="store-access"
for f in "$PLUGIN_DIR"/hooks/*.md; do
  [ -f "$f" ] || continue
  n="$(basename "$f" .md)"
  if grep -qF "$n" "$CANON"; then ok
  else bad "convention-claude-$n" "hooks/$n.md is in no SessionStart command of the canonical manifest"; fi
  if [ -f "$PLUGIN_DIR/hooks/hooks-codex.json" ]; then
    if grep -qF "$n" "$PLUGIN_DIR/hooks/hooks-codex.json"; then ok
    else bad "convention-codex-$n" "hooks/$n.md is in no SessionStart command of hooks-codex.json"; fi
  fi
  if [ "$n" = "$CURSOR_SHIM_INJECTED" ]; then continue; fi
  if [ -f "$PLUGIN_DIR/rules/fnd-$n.mdc" ]; then ok
  else bad "convention-cursor-$n" "no rules/fnd-$n.mdc — hooks/$n.md never reaches a Cursor session"; fi
done

# ------------------------------------------- smoke-test skill wired to what it verifies --
# The post-install exercise names things that live elsewhere: its reference file, the canonical
# MCP server list, and the fixture its compression row runs on. Each of those can move without
# the skill noticing, and a smoke test that probes a server the plugin no longer ships (or skips
# one it just added) reports a green install that was never checked.
SMOKE_SKILL="$PLUGIN_DIR/skills/smoke-test/SKILL.md"
SMOKE_REF="$PLUGIN_DIR/references/smoke-test-checks.md"
if [ -f "$SMOKE_SKILL" ]; then
  if [ -f "$SMOKE_REF" ]; then ok; else bad smoke-reference "references/smoke-test-checks.md missing"; fi
  if grep -qF 'references/smoke-test-checks.md' "$SMOKE_SKILL"; then ok
  else bad smoke-reference-link "smoke-test/SKILL.md does not read references/smoke-test-checks.md"; fi

  if [ -f "$SMOKE_REF" ]; then
    for s in $("$NODE_BIN" -e '
      const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      process.stdout.write(Object.keys(m.mcpServers || {}).join("\n"));
    ' "$CANON" 2>/dev/null); do
      if grep -qF "\`$s\`" "$SMOKE_REF"; then ok
      else bad "smoke-mcp-$s" "no cheap-call row for MCP server '$s' in smoke-test-checks.md"; fi
    done
    # the compression row runs a real bundled fixture — a renamed fixture would make it unrunnable
    fx="$(grep -o 'tests/fixtures/[A-Za-z0-9._-]*' "$SMOKE_REF" | head -1)"
    if [ -n "$fx" ] && [ -f "$ROOT/$fx" ]; then ok
    else bad smoke-fixture "smoke-test-checks.md names a fixture that does not exist: '${fx:-none}'"; fi
  fi
fi

# ------------------------------- Cursor marketplace mirrors the Claude one's identity --
CM="$ROOT/.cursor-plugin/marketplace.json"
CLM="$ROOT/.claude-plugin/marketplace.json"
if [ -f "$CM" ] && [ -f "$CLM" ]; then
  for k in name owner.name owner.email; do
    a="$(jval "$CM" "$k")"; b="$(jval "$CLM" "$k")"
    if [ "$a" = "$b" ]; then ok; else bad "marketplace-mirror-$k" "'$a' != '$b'"; fi
  done
fi

echo "layout-assertions: $pass passed, $fail failed"
if [ "$fail" -gt 0 ]; then printf '%s' "$failures"; exit 1; fi
