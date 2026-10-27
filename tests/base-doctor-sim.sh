#!/usr/bin/env bash
# Simulation harness for plugins/base/scripts/doctor.cjs: every case runs the doctor against a sandbox
# plugin root (--root), a sandbox home (--home) and a sandbox project (--project). No host, no
# network, nothing written outside $TMPDIR. The session rows (slim's view tool, the MCP
# servers) are the mod's and live in plugins/base/hooks/mods/tests/doctor.test.ts. Exit 0 = all green.
set -u
unset CLAUDE_CONFIG_DIR BASE_AUTOSAVE BASE_TMP_TTL DOMAINE_LOG_DIR BASE_EVENT_LOG BASE_GUARD BASE_LEAN BASE_SCRATCH_GUARD \
  BASE_SESSION_TITLE BASE_STE BASE_FIGMA_SOURCE BASE_DOGFOOD BASE_DOGFOOD_REPO BASE_EDIT_MODEL ANTHROPIC_API_KEY

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DOCTOR="$ROOT/plugins/base/scripts/doctor.cjs"
HYGIENE="$ROOT/plugins/base/scripts/scratch-hygiene.cjs"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
HEAD_BEFORE="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo none)"
O="$TMP/out"; E="$TMP/err"

pass=0; fail=0; failures=""
ok() { pass=$((pass + 1)); }
bad() { fail=$((fail + 1)); failures="${failures}  [$1] $2
"; }

rc=0
run() { rc=0; node "$DOCTOR" "$@" >"$O" 2>"$E" || rc=$?; }
WIN_SHIM="$TMP/as-win32.cjs"
printf "Object.defineProperty(process, 'platform', { value: 'win32' });\n" > "$WIN_SHIM"
runwin() { rc=0; node --require "$WIN_SHIM" "$DOCTOR" "$@" >"$O" 2>"$E" || rc=$?; }

# expect <label> <want-rc> [pattern ...] — every pattern must appear in stdout as a literal;
# a pattern prefixed with ! must NOT appear.
expect() {
  local label="$1" want="$2" p; shift 2
  if [ "$rc" -ne "$want" ]; then
    bad "$label" "exit $rc, want $want :: $(tr '\n' ';' <"$O" | head -c 400) err=$(head -c 160 "$E")"; return
  fi
  for p in "$@"; do
    if [ "${p#!}" != "$p" ]; then
      if grep -qF -- "${p#!}" "$O"; then bad "$label" "stdout has forbidden '${p#!}' :: $(tr '\n' ';' <"$O" | head -c 400)"; return; fi
    elif ! grep -qF -- "$p" "$O"; then
      bad "$label" "stdout missing '$p' :: $(tr '\n' ';' <"$O" | head -c 400)"; return
    fi
  done
  ok
}

# mkplugin <dir> — a plugin root that passes the manifest, hooks and scripts rows.
mkplugin() {
  local d="$1"
  mkdir -p "$d/.claude-plugin" "$d/hooks/mods" "$d/scripts"
  printf '{"name":"kit","version":"0.9.1","dependencies":["slim"]}\n' > "$d/.claude-plugin/plugin.json"
  printf '{ "modules": ["./mods/register.ts"] }\n' > "$d/hooks/hooks.json"
  printf 'export const register = () => {}\n' > "$d/hooks/mods/register.ts"
  printf '#!/bin/sh\nexit 0\n' > "$d/scripts/fetch.sh"; chmod 755 "$d/scripts/fetch.sh"
  printf 'trim_ws() { :; }\n' > "$d/scripts/_common.sh"; chmod 644 "$d/scripts/_common.sh"
}

# mkhome <dir> [installed-json] [settings-json] — a home with `.claude/plugins/installed_plugins.json`.
mkhome() {
  local d="$1"
  mkdir -p "$d/.claude/plugins"
  if [ -n "${2:-}" ]; then printf '%s\n' "$2" > "$d/.claude/plugins/installed_plugins.json"; fi
  # No settings given → every plugin a fixture installs is enabled, as `claude plugin install` writes it.
  local settings="${3:-}"
  [ -n "$settings" ] || settings='{"enabledPlugins":{"slim@domaine":true,"base@domaine":true}}'
  printf '%s\n' "$settings" > "$d/.claude/settings.json"
}

SLIM_USER='"slim@domaine":[{"scope":"user","version":"0.5.0"}]'
installed() { printf '{"version":2,"plugins":{%s}}' "$1"; }

P="$TMP/plugin"; mkplugin "$P"
H="$TMP/home"; mkhome "$H" "$(installed "$SLIM_USER")"
PRJ="$TMP/project"; mkdir -p "$PRJ"
git -C "$PRJ" init -q 2>/dev/null
PRJ_REAL="$(cd "$PRJ" && pwd -P)"

# ----------------------------------------------------------------------------------- green --
run --root "$P" --home "$H" --project "$PRJ"
expect CD1-green 0 "base doctor — plugin root: $P" "PASS  node" "PASS  manifest   kit 0.9.1, depends on slim" \
  "PASS  hooks      1 module(s): ./mods/register.ts" "PASS  scripts    1 shell script(s) executable" \
  "PASS  slim       slim@domaine 0.5.0 installed and enabled" \
  "PASS  base-tmp   .claude/base-tmp absent — nothing written there yet" \
  "PASS  event-log  $H/.claude/domaine/log: no session directory yet" "PASS  delegate   edit delegation: opus (no login record)" \
  "doctor: 8 passed, 0 failed, 0 skipped" "!platform"

# The shipped plugin passes its own static rows.
run --home "$H" --project "$PRJ"
expect CD2-shipped-plugin 0 "plugin root: $ROOT/plugins/base" "PASS  manifest   " "PASS  hooks      1 module(s): ./mods/register.ts" \
  "PASS  scripts    " "!FAIL"

run --root "$P" --home "$H" --project "$PRJ" --json
if node -e '
  const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const names = j.rows.map((r) => r.name).join(",");
  if (j.root !== process.argv[2] || names !== "node,manifest,hooks,scripts,slim,base-tmp,event-log,delegate") process.exit(1);
  if (!j.rows.every((r) => ["PASS","FAIL","SKIP","WARN"].includes(r.status) && typeof r.detail === "string")) process.exit(1);
' "$O" "$P" 2>/dev/null && [ "$rc" -eq 0 ] && [ "$(wc -l < "$O" | tr -d ' ')" = "1" ]; then ok
else bad CD3-json "rc=$rc out=$(head -c 300 "$O")"; fi

# ----------------------------------------------------------------------------------- usage --
run --help; expect CD4-help 0 "usage: doctor.cjs"
run --bogus; if [ "$rc" -eq 2 ] && grep -q 'unknown argument --bogus' "$E"; then ok; else bad CD5-unknown-arg "rc=$rc err=$(head -c 200 "$E")"; fi
run --root; if [ "$rc" -eq 2 ] && grep -q -- '--root needs a value' "$E"; then ok; else bad CD5b-missing-value "rc=$rc"; fi

# -------------------------------------------------------------------------------- platform --
runwin --root "$P" --home "$H" --project "$PRJ"
expect CD6-windows 1 "FAIL  platform" "native Windows is unsupported" "SKIP  scripts    no exec bits on Windows"

# -------------------------------------------------------------------------------- manifest --
M="$TMP/m1"; mkplugin "$M"; rm "$M/.claude-plugin/plugin.json"
run --root "$M" --home "$H" --project "$PRJ"; expect CD7-manifest-missing 1 "FAIL  manifest   .claude-plugin/plugin.json missing — this is not a plugin root"
printf '{ not json' > "$M/.claude-plugin/plugin.json"
run --root "$M" --home "$H" --project "$PRJ"; expect CD8-manifest-invalid 1 "FAIL  manifest   .claude-plugin/plugin.json invalid JSON"
printf '{"name":"kit"}' > "$M/.claude-plugin/plugin.json"
run --root "$M" --home "$H" --project "$PRJ"; expect CD9-manifest-no-version 1 'has no "version" string'
printf '{"name":"kit","version":"1.0.0"}' > "$M/.claude-plugin/plugin.json"
run --root "$M" --home "$H" --project "$PRJ"; expect CD10-manifest-no-slim-dep 1 'version 1.0.0 does not declare slim in "dependencies"'
# The engine loads no hooks module for its own chain member's name, while validate passes: only this
# row, which runs without the module, can say so.
for n in core engine; do
  printf '{"name":"%s","version":"1.0.0","dependencies":["slim"]}' "$n" > "$M/.claude-plugin/plugin.json"
  run --root "$M" --home "$H" --project "$PRJ"
  expect "CD10b-manifest-reserved-$n" 1 "FAIL  manifest   .claude-plugin/plugin.json name \"$n\" is the engine's own chain member" "the hooks module never loads" "!PASS  manifest"
done
printf '{"name":"corex","version":"1.0.0","dependencies":["slim"]}' > "$M/.claude-plugin/plugin.json"
run --root "$M" --home "$H" --project "$PRJ"; expect CD10c-manifest-near-reserved 0 "PASS  manifest   corex 1.0.0, depends on slim"

# ----------------------------------------------------------------------------------- hooks --
K="$TMP/k1"; mkplugin "$K"; rm "$K/hooks/hooks.json"
run --root "$K" --home "$H" --project "$PRJ"; expect CD11-hooks-missing 1 "FAIL  hooks      hooks/hooks.json missing or not a JSON object"
printf '{ "modules": [] }' > "$K/hooks/hooks.json"
run --root "$K" --home "$H" --project "$PRJ"; expect CD12-hooks-empty 1 "hooks/hooks.json lists no modules"
printf '{ "modules": ["./mods/register.ts", "./mods/gone.ts"] }' > "$K/hooks/hooks.json"
run --root "$K" --home "$H" --project "$PRJ"; expect CD13-hooks-module-missing 1 "FAIL  hooks      module(s) missing: ./mods/gone.ts"
# A mixed hooks.json: the modules, then the classic command-hook events; a ${CLAUDE_PLUGIN_ROOT} script that is not there fails.
cat > "$K/hooks/hooks.json" <<'JSON'
{ "modules": ["./mods/register.ts"],
  "hooks": {
    "SessionStart": [{ "matcher": "startup|clear|compact", "hooks": [
      { "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/conventions.cjs\" start core" },
      { "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/conventions.cjs\" start rules" },
      { "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/title.cjs\" start" }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/title.cjs\" prompt" }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/conventions.cjs\" stop" }] }] } }
JSON
run --root "$K" --home "$H" --project "$PRJ"; expect CD13b-hooks-command-script-missing 1 "FAIL  hooks      command hook script missing: hooks/conventions.cjs, hooks/title.cjs"
printf '' > "$K/hooks/conventions.cjs"
run --root "$K" --home "$H" --project "$PRJ"; expect CD13b-hooks-title-script-missing 1 "FAIL  hooks      command hook script missing: hooks/title.cjs"
printf '' > "$K/hooks/title.cjs"
run --root "$K" --home "$H" --project "$PRJ"; expect CD13c-hooks-mixed 0 "PASS  hooks      1 module(s): ./mods/register.ts; command hooks: SessionStart ×3, UserPromptSubmit, Stop"
run --root "$ROOT/plugins/base" --home "$H" --project "$PRJ"
expect CD13d-shipped-command-hooks 0 "PASS  hooks      1 module(s): ./mods/register.ts; command hooks: SessionStart ×3, UserPromptSubmit, SubagentStart, PreCompact, Stop"

# --------------------------------------------------------------------------------- scripts --
S="$TMP/s1"; mkplugin "$S"; chmod 644 "$S/scripts/fetch.sh"
run --root "$S" --home "$H" --project "$PRJ"
expect CD14-script-not-exec 1 "FAIL  scripts    fetch.sh not executable — chmod +x" "!_common.sh"

# ------------------------------------------------------------------------------------ slim --
H2="$TMP/h-noslim"; mkhome "$H2" "$(installed '')"
run --root "$P" --home "$H2" --project "$PRJ"
expect CD15-slim-absent 1 "FAIL  slim       not installed" "claude plugin install slim@domaine"
H3="$TMP/h-noinstalled"; mkhome "$H3"
run --root "$P" --home "$H3" --project "$PRJ"; expect CD15b-no-install-record 1 "FAIL  slim       not installed"
# The claude.ai-account copy (a cloud session, a synced terminal): no install record, enabled unless its key is false.
HS="$TMP/h-synced"; mkhome "$HS"; SS="$HS/.claude/plugins/synced/acc_1/slim"; mkdir -p "$SS/.claude-plugin"
printf '{"name":"slim","version":"0.9.0"}\n' > "$SS/.claude-plugin/plugin.json"
run --root "$P" --home "$HS" --project "$PRJ"; expect CD15c-slim-synced 0 "PASS  slim       slim@synced 0.9.0 installed and enabled"
printf '{"enabledPlugins":{"slim@synced":false}}\n' > "$HS/.claude/settings.json"
run --root "$P" --home "$HS" --project "$PRJ"; expect CD15d-slim-synced-off 1 "FAIL  slim       slim@synced 0.9.0 is installed but disabled"
# A re-synced plugin lives at <name>~g<N>: the highest generation is the copy.
HSG="$TMP/h-synced-gen"; mkhome "$HSG"; mkdir -p "$HSG/.claude/plugins/synced/acc_1/slim~g2/.claude-plugin" "$HSG/.claude/plugins/synced/acc_1/slim~g3/.claude-plugin"
printf '{"name":"slim","version":"0.8.0"}\n' > "$HSG/.claude/plugins/synced/acc_1/slim~g2/.claude-plugin/plugin.json"
printf '{"name":"slim","version":"0.9.2"}\n' > "$HSG/.claude/plugins/synced/acc_1/slim~g3/.claude-plugin/plugin.json"
run --root "$P" --home "$HSG" --project "$PRJ"; expect CD15e-slim-synced-generation 0 "PASS  slim       slim@synced 0.9.2 installed and enabled" "!0.8.0" "!copy:"
H4="$TMP/h-slimoff"; mkhome "$H4" "$(installed "$SLIM_USER")" '{"enabledPlugins":{"slim@domaine":false}}'
run --root "$P" --home "$H4" --project "$PRJ"
expect CD16-slim-disabled-user 1 "FAIL  slim       slim@domaine 0.5.0 is installed but disabled — enable it in /plugin"
H4b="$TMP/h-slimnokey"; mkhome "$H4b" "$(installed "$SLIM_USER")" '{}'
run --root "$P" --home "$H4b" --project "$PRJ"
expect CD16b-slim-no-key 1 "FAIL  slim       slim@domaine 0.5.0 is installed but disabled — enable it in /plugin"
PRJ2="$TMP/project2"; mkdir -p "$PRJ2/.claude"; printf '{"enabledPlugins":{"slim@domaine":false}}\n' > "$PRJ2/.claude/settings.local.json"
run --root "$P" --home "$H" --project "$PRJ2"; expect CD17-slim-disabled-project-local 1 "is installed but disabled"
printf '{"enabledPlugins":{"slim@domaine":true}}\n' > "$PRJ2/.claude/settings.json"
run --root "$P" --home "$H" --project "$PRJ2"; expect CD17b-local-beats-shared 1 "is installed but disabled"
SLIM_PROJ="\"slim@domaine\":[{\"scope\":\"project\",\"projectPath\":\"$PRJ\",\"version\":\"0.5.1\"}]"
H5="$TMP/h-slimproj"; mkhome "$H5" "$(installed "$SLIM_PROJ")"
run --root "$P" --home "$H5" --project "$PRJ"; expect CD18-slim-this-project 0 "PASS  slim       slim@domaine 0.5.1 installed and enabled"
run --root "$P" --home "$H5" --project "$PRJ2"; expect CD19-slim-other-project 1 "FAIL  slim       not installed"

# CLAUDE_CONFIG_DIR stands in for ~/.claude without --home, and --home overrides it.
H6="$TMP/h-config-dir"; mkhome "$H6" "$(installed '"slim@domaine":[{"scope":"user","version":"0.5.9"}]')"
rc=0; CLAUDE_CONFIG_DIR="$H6/.claude" node "$DOCTOR" --root "$P" --project "$PRJ" >"$O" 2>"$E" || rc=$?
expect CD22-claude-config-dir 0 "PASS  slim       slim@domaine 0.5.9 installed and enabled"
rc=0; CLAUDE_CONFIG_DIR="$H6/.claude" node "$DOCTOR" --root "$P" --home "$H" --project "$PRJ" >"$O" 2>"$E" || rc=$?
expect CD23-home-beats-config-dir 0 "PASS  slim       slim@domaine 0.5.0 installed and enabled"

# -------------------------------------------------------------------------------- base-tmp --
CT="$PRJ/.claude/base-tmp/playwright"; mkdir -p "$CT"
printf '12345' > "$CT/fresh.png"
printf '1234567890' > "$CT/old.png"; touch -t 202001010000 "$CT/old.png"
run --root "$P" --home "$H" --project "$PRJ"
expect CD24-base-tmp-unignored 0 "WARN  base-tmp   .claude/base-tmp: 2 file(s), 15 B; 1 older than 24 h (the next session sweeps them); not ignored by git"
node "$HYGIENE" --sweep "$PRJ" --ttl-hours 0 >/dev/null 2>&1
run --root "$P" --home "$H" --project "$PRJ"
expect CD25-base-tmp-ignored 0 "PASS  base-tmp   .claude/base-tmp: 2 file(s), 15 B; 1 older than 24 h (the next session sweeps them); ignored by git"
if grep -qx '/.claude/base-tmp/' "$PRJ_REAL/.git/info/exclude"; then ok; else bad CD25b-stamp "exclude=$(tr '\n' ';' < "$PRJ_REAL/.git/info/exclude" 2>&1)"; fi
rc=0; BASE_TMP_TTL=0 node "$DOCTOR" --root "$P" --home "$H" --project "$PRJ" >"$O" 2>"$E" || rc=$?
expect CD26-ttl-off 0 "2 file(s), 15 B; the sweep is off (BASE_TMP_TTL=0)" "!older than"
rc=0; BASE_TMP_TTL=junk node "$DOCTOR" --root "$P" --home "$H" --project "$PRJ" >"$O" 2>"$E" || rc=$?
expect CD27-ttl-junk-default 0 "1 older than 24 h"
NOGIT="$TMP/nogit"; mkdir -p "$NOGIT/.claude/base-tmp"; printf 'x' > "$NOGIT/.claude/base-tmp/a"
rc=0; (cd "$TMP" && GIT_CEILING_DIRECTORIES="$TMP" node "$DOCTOR" --root "$P" --home "$H" --project "$NOGIT") >"$O" 2>"$E" || rc=$?
expect CD28-base-tmp-no-git 0 "PASS  base-tmp   .claude/base-tmp: 1 file(s), 1 B" "!not ignored" "!ignored by git"
# A symlinked component is never walked: the count would be someone else's files.
LNK="$TMP/linked"; mkdir -p "$LNK/.claude" "$TMP/elsewhere"; printf 'x' > "$TMP/elsewhere/f"
ln -s "$TMP/elsewhere" "$LNK/.claude/base-tmp"
run --root "$P" --home "$H" --project "$LNK"; expect CD29-base-tmp-symlink 0 "PASS  base-tmp   .claude/base-tmp absent"

# ------------------------------------------------------------------------------- event-log --
jl() { printf '{"ts":"%s","plugin":"%s","version":"0.1.0","session":"s1","kind":"start","agent":"main","text":"x"}\n' "$2" "$1"; }
LD="$TMP/logs/s1"; mkdir -p "$LD"
{ jl base 2026-10-08T09:00:00.000Z; jl base 2026-10-08T09:05:00.000Z; } > "$LD/base.jsonl"
jl band 2026-10-08T09:01:00.000Z > "$LD/band.jsonl"
printf 'not a log' > "$LD/notes.txt"
run --root "$P" --home "$H" --project "$PRJ" --log-dir "$LD"
expect CD30-event-log-session 0 "PASS  event-log  $LD: band.jsonl 1 line(s), newest 2026-10-08T09:01:00.000Z; base.jsonl 2 line(s), newest 2026-10-08T09:05:00.000Z" "!notes.txt"
printf '{ cut mid-line\n' >> "$LD/band.jsonl"
run --root "$P" --home "$H" --project "$PRJ" --log-dir "$LD"
expect CD31-event-log-unreadable-last 0 "band.jsonl 2 line(s), newest unreadable"
# A /clear's new id has no directory before its first line: not a failed write.
run --root "$P" --home "$H" --project "$PRJ" --log-dir "$TMP/logs/gone"
expect CD32-event-log-no-dir-yet 0 "PASS  event-log  $TMP/logs/gone: no line yet this session" "!warned" "!every write failed"
mkdir -p "$TMP/nolog/empty"
run --root "$P" --home "$H" --project "$PRJ" --log-dir "$TMP/nolog/empty"
expect CD32b-event-log-dir-without-log 0 "WARN  event-log  $TMP/nolog/empty: no event log written — every write failed (base toasts the reason)" ", 1 warned"
rc=0; BASE_EVENT_LOG=0 node "$DOCTOR" --root "$P" --home "$H" --project "$PRJ" --log-dir "$TMP/nolog/empty" >"$O" 2>"$E" || rc=$?
expect CD33-event-log-off 0 "PASS  event-log  $TMP/nolog/empty: no event log written; base's is off (BASE_EVENT_LOG=0)" "!warned"
# By hand (no --log-dir): the newest session directory under <home>/.claude/domaine/log, a link never followed.
HL="$TMP/h-logs"; mkhome "$HL" "$(installed "$SLIM_USER")"; R="$HL/.claude/domaine/log"
mkdir -p "$R/old" "$R/new"; jl base 2026-10-01T00:00:00.000Z > "$R/old/base.jsonl"; jl slim 2026-10-08T00:00:00.000Z > "$R/new/slim.jsonl"
touch -t 202010010000 "$R/old/base.jsonl" "$R/old"
mkdir -p "$TMP/elsewhere-log"; jl base 2026-10-09T00:00:00.000Z > "$TMP/elsewhere-log/base.jsonl"; ln -s "$TMP/elsewhere-log" "$R/zlink"
run --root "$P" --home "$HL" --project "$PRJ"
expect CD34-event-log-newest-by-hand 0 "PASS  event-log  $R/new: slim.jsonl 1 line(s), newest 2026-10-08T00:00:00.000Z" "!elsewhere-log"
rc=0; DOMAINE_LOG_DIR="$TMP/logs" node "$DOCTOR" --root "$P" --home "$HL" --project "$PRJ" >"$O" 2>"$E" || rc=$?
expect CD35-event-log-override 0 "PASS  event-log  $LD: band.jsonl" "!$R"
rc=0; DOMAINE_LOG_DIR=relative/logs node "$DOCTOR" --root "$P" --home "$HL" --project "$PRJ" >"$O" 2>"$E" || rc=$?
expect CD36-event-log-relative-override-ignored 0 "PASS  event-log  $R/new: slim.jsonl"
run --root "$P" --home "$H" --project "$PRJ" --log-dir; if [ "$rc" -eq 2 ] && grep -q -- '--log-dir needs a value' "$E"; then ok; else bad CD37-log-dir-value "rc=$rc"; fi

# -------------------------------------------------------------------------------- switches --
# A value outside a switch's README domain is read as the default without a word: the doctor says it,
# as a WARN — never a FAIL — and says nothing while every value is in its domain.
rc=0; BASE_LEAN=0 BASE_EVENT_LOG=1 BASE_FIGMA_SOURCE=' rest ' BASE_TMP_TTL=48 \
  node "$DOCTOR" --root "$P" --home "$H" --project "$PRJ" >"$O" 2>"$E" || rc=$?
expect CD38-switches-valid 0 "!switches" "!warned"
rc=0; BASE_LEAN=false BASE_GUARD=' 0' BASE_FIGMA_SOURCE=figma BASE_TMP_TTL=abc \
  node "$DOCTOR" --root "$P" --home "$H" --project "$PRJ" >"$O" 2>"$E" || rc=$?
expect CD39-switches-invalid 0 'WARN  switches' 'BASE_GUARD=" 0" is read as on — only 0 turns it off' \
  'BASE_LEAN="false" is read as on — only 0 turns it off' 'BASE_FIGMA_SOURCE="figma" is read as auto — auto, mcp or rest' \
  'BASE_TMP_TTL="abc" is read as 24 — hours, 0 or more' "doctor: 8 passed, 0 failed, 0 skipped, 1 warned"
rc=0; BASE_TMP_TTL=-1 node "$DOCTOR" --root "$P" --home "$H" --project "$PRJ" --json >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && node -e '
  const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const r = j.rows.filter((x) => x.name === "switches");
  if (r.length !== 1 || r[0].status !== "WARN" || !r[0].detail.startsWith("BASE_TMP_TTL=\"-1\"")) process.exit(1);
' "$O" 2>/dev/null; then ok
else bad CD39b-switches-json "rc=$rc out=$(head -c 300 "$O")"; fi
rc=0; BASE_AUTOSAVE=off node "$DOCTOR" --root "$P" --home "$H" --project "$PRJ" >"$O" 2>"$E" || rc=$?
expect CD39c-switches-autosave 0 'WARN  switches' 'BASE_AUTOSAVE="off" is read as on — only 0 turns it off'
rc=0; BASE_AUTOSAVE=0 node "$DOCTOR" --root "$P" --home "$H" --project "$PRJ" >"$O" 2>"$E" || rc=$?
expect CD39d-switches-autosave-off 0 "!switches"
rc=0; BASE_DOGFOOD=1 BASE_DOGFOOD_REPO=acme/claude-plugins node "$DOCTOR" --root "$P" --home "$H" --project "$PRJ" >"$O" 2>"$E" || rc=$?
expect CD39e-switches-dogfood-valid 0 "!switches"
rc=0; BASE_DOGFOOD=yes BASE_DOGFOOD_REPO='https://github.com/acme/x' node "$DOCTOR" --root "$P" --home "$H" --project "$PRJ" >"$O" 2>"$E" || rc=$?
expect CD39f-switches-dogfood-invalid 0 'WARN  switches' 'BASE_DOGFOOD="yes" is read as off — only 1 turns it on' \
  'BASE_DOGFOOD_REPO="https://github.com/acme/x" is not <owner>/<repo> — plugin_defect files no GitHub issue'
rc=0; BASE_SHOPIFY_VALIDATE=0 BASE_SHOPIFY_VALIDATE_TIMEOUT=120 node "$DOCTOR" --root "$P" --home "$H" --project "$PRJ" >"$O" 2>"$E" || rc=$?
expect CD39g-switches-shopify-validate-valid 0 "!switches"
rc=0; BASE_SHOPIFY_VALIDATE=no BASE_SHOPIFY_VALIDATE_TIMEOUT=900 node "$DOCTOR" --root "$P" --home "$H" --project "$PRJ" >"$O" 2>"$E" || rc=$?
expect CD39h-switches-shopify-validate-invalid 0 'WARN  switches' 'BASE_SHOPIFY_VALIDATE="no" is read as on — only 0 turns it off' \
  'BASE_SHOPIFY_VALIDATE_TIMEOUT="900" is read as 90 — seconds, 1-600'

# ----------------------------------------------------------------------------------- cache --
# Claude Code keeps every installed version under cache/domaine/<name>/: the doctor lists the ones no install
# record names, as a WARN, never a FAIL; an all-recorded cache, another marketplace's and a dot dir are silent.
HC="$TMP/hcache"; C="$HC/.claude/plugins/cache"
mkhome "$HC" "$(installed '"slim@domaine":[{"scope":"user","installPath":"'"$C"'/domaine/slim/0.14.1","version":"0.14.1"}],"fe@domaine":[{"scope":"user","version":"0.9.1"},{"scope":"project","projectPath":"/p","version":"0.8.0"}],"figma@official":[{"scope":"user","version":"2.0.0"}]')"
mkdir -p "$C/domaine/slim/0.14.1" "$C/domaine/fe/0.9.1" "$C/domaine/fe/0.8.0" "$C/official/figma/1.0.0"
run --root "$P" --home "$HC" --project "$PRJ"
expect CD40-cache-clean 0 "!WARN  cache" "!warned"
mkdir -p "$C/domaine/slim/0.9.0" "$C/domaine/slim/0.10.2" "$C/domaine/slim/.tmp" "$C/domaine/fe/0.9.0" "$C/domaine/band/0.1.0"
run --root "$P" --home "$HC" --project "$PRJ"
expect CD41-cache-stale 0 "WARN  cache" "stale versions in $C/domaine: fe 0.9.0; slim 0.9.0, 0.10.2 — scripts/install.sh --prune-cache" \
  "!band 0.1.0" "!.tmp" "!figma" "doctor: 8 passed, 0 failed, 0 skipped, 1 warned"
# What --prune-cache leaves is never listed: a version a live session holds, a plugin with no recorded version on disk.
mkdir -p "$C/domaine/slim/0.10.2/.in_use/$$" "$C/domaine/slim/0.9.0/.in_use/2147483646"
rm -rf "$C/domaine/fe/0.9.1" "$C/domaine/fe/0.8.0"
run --root "$P" --home "$HC" --project "$PRJ"
expect CD42-cache-prune-rules 0 "WARN  cache" "stale versions in $C/domaine: slim 0.9.0 — scripts/install.sh --prune-cache" \
  "!0.10.2" "!fe 0.9.0"

# ---------------------------------------------------------------------------------- copies --
# A plugin with both an install record and a claude.ai-synced copy gets a copy:<name> row: which copy this session
# loaded (base: its own root; the others: their start line in the session log), WARN when the synced one is older.
HY="$TMP/hcopies"; SY="$HY/.claude/plugins/synced/acc_1"; LY="$TMP/logs-copies/s1"; mkdir -p "$LY"
mkhome "$HY" "$(installed "$SLIM_USER"',"base@domaine":[{"scope":"user","installPath":"/c/base/0.9.1","version":"0.9.1"}],"fe@domaine":[{"scope":"user","installPath":"/c/fe/0.5.0","version":"0.5.0"}]')" \
  '{"enabledPlugins":{"slim@domaine":true,"base@domaine":true,"fe@domaine":true}}'
synced() { mkdir -p "$SY/$1/.claude-plugin"; printf '{"name":"%s","version":"%s"}\n' "${1%%~*}" "$2" > "$SY/$1/.claude-plugin/plugin.json"; }
synced base~g2 0.8.0
run --root "$P" --home "$HY" --project "$PRJ" --log-dir "$LY"
expect CD52-copy-install-loaded-synced-older 0 "WARN  copy:base  this session loaded the install 0.9.1; install base@domaine 0.9.1 (/c/base/0.9.1), synced base@synced 0.8.0 ($SY/base~g2): the synced copy is older and a session that loads it (the desktop app, a claude.ai cloud session) runs it — re-sync base from claude.ai (upload the 0.9.1 build) or turn it off with \"base@synced\": false in settings.json enabledPlugins" \
  "!copy:fe" "!copy:slim"
mkplugin "$SY/base~g2"; sed -i.bak 's/0.9.1/0.8.0/' "$SY/base~g2/.claude-plugin/plugin.json"
run --root "$SY/base~g2" --home "$HY" --project "$PRJ" --log-dir "$LY"
expect CD53-copy-base-synced-root 0 "WARN  copy:base  this session loaded the synced copy 0.8.0;" "the synced copy is older and this session runs it — re-sync base"
synced fe~g2 0.3.0; synced fe~g3 0.4.0
printf '{"plugin":"fe","version":"0.4.0","kind":"start"}\n{"plugin":"fe","kind":"tool","text":"x"}\n' > "$LY/fe.jsonl"
run --root "$P" --home "$HY" --project "$PRJ" --log-dir "$LY"
expect CD54-copy-start-line-synced 0 "WARN  copy:fe    this session loaded the synced copy 0.4.0; install fe@domaine 0.5.0 (/c/fe/0.5.0), synced fe@synced 0.4.0 ($SY/fe~g3): the synced copy is older and this session runs it" "!0.3.0"
rm "$LY/fe.jsonl"
run --root "$P" --home "$HY" --project "$PRJ" --log-dir "$LY"
expect CD55-copy-no-start-line 0 "WARN  copy:fe    no start line from fe in $LY: the loaded copy is unknown;" "a session that loads it"
synced fe~g4 0.6.0; printf '{"plugin":"fe","version":"0.5.0","kind":"start"}\n' > "$LY/fe.jsonl"
run --root "$P" --home "$HY" --project "$PRJ" --log-dir "$LY"
expect CD56-copy-synced-newer 0 "PASS  copy:fe    this session loaded the install 0.5.0;" "fe@synced 0.6.0 ($SY/fe~g4): the synced copy is newer" "!re-sync fe"
synced fe~g5 0.5.0
run --root "$P" --home "$HY" --project "$PRJ" --log-dir "$LY"
expect CD57-copy-same-version 0 "PASS  copy:fe    this session loaded fe 0.5.0; install fe@domaine 0.5.0 (/c/fe/0.5.0), synced fe@synced 0.5.0 ($SY/fe~g5): the same version"
printf '{"enabledPlugins":{"slim@domaine":true,"base@domaine":true,"fe@domaine":true,"base@synced":false}}\n' > "$HY/.claude/settings.json"
run --root "$P" --home "$HY" --project "$PRJ" --log-dir "$LY"
expect CD58-copy-synced-off 0 "PASS  copy:base  install base@domaine 0.9.1 (/c/base/0.9.1), synced base@synced 0.8.0 ($SY/base~g2); the synced copy is off (\"base@synced\": false)"
run --root "$P" --home "$H" --project "$PRJ"; expect CD59-copy-none 0 "!copy:"

# -------------------------------------------------------------------------------- delegate --
# The edit-delegation model hooks/conventions.cjs announces, from the same function: the login record under --home
# (else CLAUDE_CONFIG_DIR's), BASE_EDIT_MODEL over it; an api-key session's key value is never printed.
TEAM='{"oauthAccount":{"organizationType":"claude_team"}}'
GATED='{"oauthAccount":{"organizationType":"claude_pro"},"cachedExtraUsageDisabledReason":"out_of_credits","additionalModelOptionsCache":[{"value":"claude-opus-5-5"}],"cachedGrowthBookFeatures":{"tengu_saffron_lattice":{"perModel":{"claude-opus-5-5":{"enabled":true}}}}}'
printf '%s' "$TEAM" > "$H/.claude.json"
run --root "$P" --home "$H" --project "$PRJ"; expect CD43-delegate-team 0 "PASS  delegate   edit delegation: sonnet (work login, Claude Team)"
printf '{"oauthAccount":{"organizationType":"claude_max"}}' > "$H/.claude.json"
run --root "$P" --home "$H" --project "$PRJ"; expect CD44-delegate-max 0 "edit delegation: opus (personal login, Claude Max)"
printf '%s' "$GATED" > "$H/.claude.json"
run --root "$P" --home "$H" --project "$PRJ"; expect CD45-delegate-gated 0 "edit delegation: sonnet (personal login, Claude Pro, opus needs credits)"
rm -f "$H/.claude.json"
run --root "$P" --home "$H" --project "$PRJ"; expect CD46-delegate-missing 0 "edit delegation: opus (no login record)"
rc=0; BASE_EDIT_MODEL=haiku node "$DOCTOR" --root "$P" --home "$H" --project "$PRJ" >"$O" 2>"$E" || rc=$?
expect CD47-delegate-override 0 "PASS  delegate   edit delegation: haiku (BASE_EDIT_MODEL)" "!WARN  switches"
rc=0; BASE_EDIT_MODEL=0 node "$DOCTOR" --root "$P" --home "$H" --project "$PRJ" >"$O" 2>"$E" || rc=$?
expect CD48-delegate-off 0 "SKIP  delegate   edit delegation: off (BASE_EDIT_MODEL=0)" "doctor: 7 passed, 0 failed, 1 skipped" "!switches"
printf '%s' "$TEAM" > "$H/.claude.json"
rc=0; BASE_EDIT_MODEL=fable node "$DOCTOR" --root "$P" --home "$H" --project "$PRJ" >"$O" 2>"$E" || rc=$?
expect CD49-delegate-invalid 0 "WARN  switches" 'BASE_EDIT_MODEL="fable" is read as unset — opus, sonnet, haiku or 0' \
  "edit delegation: sonnet (work login, Claude Team)"
mkdir -p "$TMP/cfg"; printf '%s' "$TEAM" > "$TMP/cfg/.claude.json"; printf '{"oauthAccount":{"organizationType":"claude_max"}}' > "$H/.claude.json"
rc=0; HOME="$H" CLAUDE_CONFIG_DIR="$TMP/cfg" node "$DOCTOR" --root "$P" --project "$PRJ" >"$O" 2>"$E" || rc=$?
expect CD50-delegate-config-dir 1 "edit delegation: sonnet (work login, Claude Team)"
rc=0; HOME="$H" CLAUDE_CONFIG_DIR="$TMP/cfg" node "$DOCTOR" --root "$P" --home "$H" --project "$PRJ" >"$O" 2>"$E" || rc=$?
expect CD50b-delegate-home-wins 0 "edit delegation: opus (personal login, Claude Max)"
printf '{}' > "$H/.claude.json"
rc=0; ANTHROPIC_API_KEY=sk-x node "$DOCTOR" --root "$P" --home "$H" --project "$PRJ" >"$O" 2>"$E" || rc=$?
expect CD51-delegate-api-key 0 "edit delegation: sonnet (api-key session)" "!sk-x"
rc=0; ANTHROPIC_API_KEY=sk-x node "$DOCTOR" --root "$P" --home "$H" --project "$PRJ" --json >"$O" 2>"$E" || rc=$?
expect CD51b-delegate-api-key-json 0 '"name":"delegate"' "!sk-x"
rm -rf "$H/.claude.json" "$TMP/cfg"

# The suite never touched the real checkout.
if [ "$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo none)" = "$HEAD_BEFORE" ]; then ok; else bad CD-head "HEAD moved"; fi

echo "base-doctor-sim: $pass passed, $fail failed"
if [ "$fail" -gt 0 ]; then printf '%s' "$failures"; exit 1; fi
