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
# NB the asymmetry: json-slim.cjs and log-slim.cjs are NOT listed here either — widening this list
# to every bundled script is a separate change. scratch-hygiene.cjs is listed because it is NEW and
# its only coverage lives inside ANOTHER module's suite (tests/json-slim-fixtures.mjs).
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
         "$PLUGIN_DIR/scripts/scratch-hygiene.cjs" \
         "$ROOT/tests/opencode-config-sim.sh"; do
  if [ -f "$f" ]; then ok; else bad "exists-${f#$ROOT/}" "missing"; fi
done

# Both entry scripts are documented as `./scripts/<name>.sh`, so the mode bit git carries is part
# of the packaging: a lost +x turns a documented install command into "permission denied". The
# profile probe and the attachment fetcher are here because both are documented as by-hand
# diagnostics (README, FND_PROFILE; the preflight `--check` row) — every wiring already runs them
# through `bash`, so the bit is a convenience, not the contract.
for f in "$ROOT/scripts/install.sh" "$ROOT/scripts/bootstrap.sh" \
         "$PLUGIN_DIR/scripts/project-profile.sh" "$PLUGIN_DIR/scripts/jira-attachments.sh"; do
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
  # Codex parses ONLY `defaultPrompt` (string or string array); a pluralised key is accepted by
  # JSON and then silently ignored, so the typo has to fail here rather than at a user's prompt bar.
  if [ -z "$(jval "$CODEX_MANIFEST" interface.defaultPrompts.length)" ] \
    && [ -z "$(jval "$CODEX_MANIFEST" interface.defaultPrompts)" ]; then ok
  else bad codex-interface-prompts-key "undocumented 'interface.defaultPrompts' — the key Codex reads is 'defaultPrompt'"; fi
  n_prompts="$(jval "$CODEX_MANIFEST" interface.defaultPrompt.length)"
  case "$n_prompts" in
    [2-9]|[1-9][0-9]) ok ;;
    *) bad codex-interface-prompts "want 2+ defaultPrompt entries, got '$n_prompts'" ;;
  esac
  i=0
  while [ "$i" -lt "${n_prompts:-0}" ]; do
    p="$(jval "$CODEX_MANIFEST" "interface.defaultPrompt.$i")"
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
# Two files are the exception on Cursor only: the shim injects them where the workspace says so
# (store credentials; Foundation markers) instead of shipping them as always-applied rules —
# gen-host-adapters.cjs's RULE_EXEMPT_HOOKS is the same pair.
# The two shell wirings hold the composition one hop away: each SessionStart command spawns
# hooks/session-start.sh and that script names the conventions, so both halves of the trail are
# asserted — a wiring that stopped spawning the script, or a script that stopped naming a file,
# is the same silent loss as an unwired convention was before the split.
SS_SCRIPT="$PLUGIN_DIR/hooks/session-start.sh"
if [ -f "$SS_SCRIPT" ]; then ok
else bad session-start-script "hooks/session-start.sh missing — both shell wirings spawn it"; fi
if grep -qF 'hooks/session-start.sh' "$CANON"; then ok
else bad session-start-claude "the canonical manifest's SessionStart command does not spawn hooks/session-start.sh"; fi
if [ -f "$PLUGIN_DIR/hooks/hooks-codex.json" ]; then
  if grep -qF 'hooks/session-start.sh' "$PLUGIN_DIR/hooks/hooks-codex.json"; then ok
  else bad session-start-codex "hooks-codex.json's SessionStart command does not spawn hooks/session-start.sh"; fi
fi
CURSOR_SHIM_INJECTED="store-access comment-discipline-foundation"
# The conventions the script cats through `for f in … ; do cat "$root/hooks/$f.md"` — a runtime
# path, so the file name never appears literally and the census has to read the loop's word list.
SS_LOOP_NAMES="$(sed -n 's/^for f in \(.*\); do$/\1/p' "$SS_SCRIPT" | tr '\n' ' ')"
for f in "$PLUGIN_DIR"/hooks/*.md; do
  [ -f "$f" ] || continue
  n="$(basename "$f" .md)"
  # The full referenced path, or a whole word of the `for f in …` list — never a bare substring:
  # `comment-discipline` matches inside the `comment-discipline-foundation.md` line, so a deleted
  # plain-convention `cat` would otherwise still read as present.
  named=0
  grep -qF "hooks/$n.md" "$SS_SCRIPT" && named=1
  case " $SS_LOOP_NAMES " in *" $n "*) named=1 ;; esac
  if [ "$named" -eq 1 ]; then ok
  else bad "convention-shell-$n" "hooks/$n.md is named nowhere in hooks/session-start.sh — the script both shell wirings spawn"; fi
  case " $CURSOR_SHIM_INJECTED " in *" $n "*) continue ;; esac
  if [ -f "$PLUGIN_DIR/rules/fnd-$n.mdc" ]; then ok
  else bad "convention-cursor-$n" "no rules/fnd-$n.mdc — hooks/$n.md never reaches a Cursor session"; fi
done

# --------------------------- the detection-gated pair, held equal across its three literal homes --
# One pair of conventions is injected on detection instead of shipped statically, and THREE
# literals say so independently: gen-host-adapters.cjs's RULE_EXEMPT_HOOKS (no Cursor rule),
# opencode-config.cjs's ADAPTER_INJECTED (kept out of the `instructions` paste) and the list
# above. A name in only two of them is a convention delivered twice on one host and never on
# another — and each name has to be reachable in the two adapters that inject it, or the
# exemption is simply a deletion.
RULE_EXEMPT_JS="$(grep -oE 'const RULE_EXEMPT_HOOKS = \[[^]]*\]' "$PLUGIN_DIR/scripts/gen-host-adapters.cjs" \
  | grep -oE "'[A-Za-z0-9._-]+'" | tr -d "'" | sort | tr '\n' ' ')"
ADAPTER_INJ_JS="$(grep -oE 'const ADAPTER_INJECTED = new Set\(\[[^]]*\]' "$PLUGIN_DIR/scripts/opencode-config.cjs" \
  | grep -oE "'[A-Za-z0-9._-]+'" | tr -d "'" | sed 's/\.md$//' | sort | tr '\n' ' ')"
SHIM_INJ_LIST="$(printf '%s\n' $CURSOR_SHIM_INJECTED | sort | tr '\n' ' ')"
if [ -n "$RULE_EXEMPT_JS" ] && [ "$RULE_EXEMPT_JS" = "$SHIM_INJ_LIST" ] && [ "$ADAPTER_INJ_JS" = "$SHIM_INJ_LIST" ]; then ok
else bad detection-gated-set "gen-host-adapters='$RULE_EXEMPT_JS' opencode-config='$ADAPTER_INJ_JS' suite='$SHIM_INJ_LIST'"; fi
for n in $SHIM_INJ_LIST; do
  for a in opencode/fnd-plugin.js hooks/cursor-shim.cjs; do
    if grep -qF "$n.md" "$PLUGIN_DIR/$a"; then ok
    else bad "detection-gated-${a##*/}-$n" "$n.md is detection-gated but $a never injects it"; fi
  done
done

# ------------------------------------ the project-layer allowlist, mirrored into two bash readers --
# scripts/env-file.cjs's PROJECT_OK is the class boundary a client repo's committed
# `.claude/domaine.env` is read through, and the two shell readers of the same dialect
# (scripts/_shopify-common.sh's domaine_env(), hooks/spill-access.sh's env_get()) carry that list
# BY HAND — env-file.cjs says so in a comment nothing ran until here. A key added to one copy and
# not the others is a switch that reaches Node from a project file and not bash, silently.
PROJECT_OK_JS="$("$NODE_BIN" -e '
  const s = require(process.argv[1]).PROJECT_OK;
  process.stdout.write([...s].sort().join(" "));
' "$PLUGIN_DIR/scripts/env-file.cjs" 2>/dev/null)"
if [ -n "$PROJECT_OK_JS" ]; then ok
else bad project-ok-read "cannot read PROJECT_OK out of scripts/env-file.cjs"; fi
for m in scripts/_shopify-common.sh hooks/spill-access.sh; do
  arm="$(grep -oE 'FND_LEAN\|[A-Z0-9_|]+' "$PLUGIN_DIR/$m" | head -1)"
  got="$(printf '%s' "$arm" | tr '|' '\n' | sort | tr '\n' ' ')"
  got="${got% }"
  if [ "$got" = "$PROJECT_OK_JS" ]; then ok
  else bad "project-ok-mirror-${m##*/}" "$m's case list is not env-file.cjs's PROJECT_OK: '$got' vs '$PROJECT_OK_JS'"; fi
done

# --------------------------------------- one dotenv dialect for every bundled shell script --
# The reader lives in _shopify-common.sh and the callers source it. A second definition is a second
# dialect: the CRLF, quoted-value and trailing-comment bugs the shared one was written to fix come
# back in the copy, and only the script holding the copy would ever say so.
dv_homes="$(grep -l '^dotenv_value() {' "$PLUGIN_DIR"/scripts/*.sh 2>/dev/null \
  | sed "s|^$PLUGIN_DIR/scripts/||" | sort | tr '\n' ' ')"
if [ "$dv_homes" = "_shopify-common.sh " ]; then ok
else bad dotenv-value-home "dotenv_value() is defined in '${dv_homes:-nothing}' — want _shopify-common.sh alone"; fi

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

# --------------------------------------- the repo conventions have one body, two names --
# Codex reads AGENTS.md, Claude Code reads CLAUDE.md. A symlink keeps them one file: a copy
# would drift, and only the host that read the stale half would ever say so.
if [ -L "$ROOT/AGENTS.md" ] && [ "$(readlink "$ROOT/AGENTS.md")" = "CLAUDE.md" ]; then ok
else bad agents-md "AGENTS.md is not a symlink to CLAUDE.md"; fi
# The index mode is a git fact — a tarball copy has none to check.
if git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1; then
  if [ "$(git -C "$ROOT" ls-files -s AGENTS.md 2>/dev/null | cut -d' ' -f1)" = "120000" ]; then ok
  else bad agents-md-mode "AGENTS.md is not committed as a symlink — a clone would get a copy"; fi
fi

# ------------------------- the review agents' core rules ride the project profile (item 1) --
# scripts/project-profile.sh is the ONE place that decides what kind of checkout this is, and
# theme-explorer / change-reviewer sit in hooks/subagent-conventions.sh's EXEMPT list — the word
# reaches them only through their brief or through that probe. Ungated, `protected-core` invents
# findings on a Dawn/Horizon theme; gated wrongly, a Foundation checkout loses the blocker
# silently, so the fail-safe rung ("assume foundation") is asserted too. A second marker list
# inside an agent would be the same detection written twice: `layout/theme.liquid` is the probe's
# own `theme` marker and must appear in neither agent.
if [ -f "$PLUGIN_DIR/scripts/project-profile.sh" ]; then ok
else bad profile-probe "scripts/project-profile.sh missing — the agents' fallback names it"; fi
for a in theme-explorer change-reviewer; do
  f="$PLUGIN_DIR/agents/$a.md"
  if [ ! -f "$f" ]; then bad "profile-agent-$a" "agents/$a.md missing"; continue; fi
  if grep -qF 'foundation|theme|none' "$f"; then ok
  else bad "profile-brief-$a" "agents/$a.md never names the brief's profile: foundation|theme|none"; fi
  if grep -qF 'scripts/project-profile.sh' "$f"; then ok
  else bad "profile-fallback-$a" "agents/$a.md has no project-profile.sh fallback for a brief without a profile"; fi
  if grep -qF 'assume `foundation`' "$f"; then ok
  else bad "profile-failsafe-$a" "agents/$a.md does not fall back to foundation — a Foundation checkout could lose its core rule"; fi
  if grep -qF '`theme` / `none`' "$f"; then ok
  else bad "profile-plain-$a" "agents/$a.md has no theme/none branch — the core rules are still unconditional"; fi
  if grep -qF 'always true' "$f"; then
    bad "profile-invariant-$a" "agents/$a.md still calls a Foundation rule 'always true'"
  else ok; fi
  if grep -qF 'layout/theme.liquid' "$f"; then
    bad "profile-second-list-$a" "agents/$a.md carries its own detection markers — project-profile.sh is the single source"
  else ok; fi
done
# `protected-core` keeps its name and its blocker, scoped to the JS/TS core the vendored
# rules/core.mdc actually protects (the Liquid core is a hand-sync warning, not a blocker).
CR="$PLUGIN_DIR/agents/change-reviewer.md"
if [ -f "$CR" ]; then
  if grep -qF 'protected-core' "$CR" && grep -qF 'src/entry/core/*' "$CR"; then ok
  else bad protected-core-name "change-reviewer.md lost the protected-core finding or its src/entry/core scope"; fi
fi
# Every caller that spawns one of these agents hands the word over, so the probe is a fallback and
# not the normal path — review-flow §2 is the brief contract, the rest are the spawn sites.
for f in references/review-flow.md \
         skills/pre-commit-review/SKILL.md \
         skills/create-pull-request/SKILL.md \
         skills/develop-feature-or-fix/SKILL.md \
         skills/ship/SKILL.md; do
  [ -f "$PLUGIN_DIR/$f" ] || { bad "profile-caller-missing-$f" "missing"; continue; }
  if grep -qF 'foundation|theme|none' "$PLUGIN_DIR/$f"; then ok
  else bad "profile-caller-$f" "$f spawns a profile-gated agent without passing the profile"; fi
  # A caller that restates the old binary rule re-blocks what the agent now returns as a
  # hand-sync warning, at the gate that consumes the agent's rows — passing the profile down
  # is worth nothing if the consumer overrides the severity on the way back.
  if grep -qF '`protected-core` is always a blocker' "$PLUGIN_DIR/$f"; then
    bad "profile-severity-$f" "$f still calls every protected-core row a blocker — it overrides the agent's warning"
  else ok; fi
done

echo "layout-assertions: $pass passed, $fail failed"
if [ "$fail" -gt 0 ]; then printf '%s' "$failures"; exit 1; fi
