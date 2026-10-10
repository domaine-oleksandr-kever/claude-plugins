#!/usr/bin/env bash
# Simulation harness for plugins/be/scripts/doctor.cjs: every case runs the doctor against a sandbox plugin
# root (--root), a sandbox home (--home) whose installed_plugins.json points at a sandbox base, and a sandbox
# project (--project). No host, no network, nothing written outside $TMPDIR. The session rows (base loaded,
# slim's view tool) are the mod's and live in plugins/be/hooks/mods/tests/doctor.test.ts.
# Exit 0 = all green.
set -u
unset CLAUDE_CONFIG_DIR DOMAINE_LOG_DIR BE_EVENT_LOG

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DOCTOR="$ROOT/plugins/be/scripts/doctor.cjs"
NODE="$(command -v node)"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
HEAD_BEFORE="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo none)"
O="$TMP/out"; E="$TMP/err"

pass=0; fail=0; failures=""
ok() { pass=$((pass + 1)); }
bad() { fail=$((fail + 1)); failures="${failures}  [$1] $2
"; }

rc=0
run() { rc=0; PATH="/usr/bin:/bin" "$NODE" "$DOCTOR" "$@" >"$O" 2>"$E" || rc=$?; }
WIN_SHIM="$TMP/as-win32.cjs"
printf "Object.defineProperty(process, 'platform', { value: 'win32' });\n" > "$WIN_SHIM"
runwin() { rc=0; PATH="/usr/bin:/bin" "$NODE" --require "$WIN_SHIM" "$DOCTOR" "$@" >"$O" 2>"$E" || rc=$?; }

# expect <label> <want-rc> [pattern ...] — every pattern must appear in stdout as a literal;
# a pattern prefixed with ! must NOT appear.
expect() {
  local label="$1" want="$2" p; shift 2
  if [ "$rc" -ne "$want" ]; then
    bad "$label" "exit $rc, want $want :: $(tr '\n' ';' <"$O" | head -c 500) err=$(head -c 160 "$E")"; return
  fi
  for p in "$@"; do
    if [ "${p#!}" != "$p" ]; then
      if grep -qF -- "${p#!}" "$O"; then bad "$label" "stdout has forbidden '${p#!}' :: $(tr '\n' ';' <"$O" | head -c 500)"; return; fi
    elif ! grep -qF -- "$p" "$O"; then
      bad "$label" "stdout missing '$p' :: $(tr '\n' ';' <"$O" | head -c 500)"; return
    fi
  done
  ok
}

# mkplugin <dir> — a plugin root that passes the manifest and scripts rows: one run-by-path script, one
# sourced helper without its bit, one .cjs that parses.
mkplugin() {
  local d="$1"
  mkdir -p "$d/.claude-plugin" "$d/scripts"
  printf '{"name":"be","version":"0.9.1","dependencies":["base"]}\n' > "$d/.claude-plugin/plugin.json"
  printf '#!/bin/sh\nexit 0\n' > "$d/scripts/fetch.sh"; chmod 755 "$d/scripts/fetch.sh"
  printf 'trim_ws() { :; }\n' > "$d/scripts/_common.sh"; chmod 644 "$d/scripts/_common.sh"
  printf "'use strict';\nmodule.exports = 1;\n" > "$d/scripts/check.cjs"
}

# mkbase <dir> [mcpServers-json] — an installed base's root: its manifest and the servers it declares.
BASE_SERVERS='{"atlassian":{},"shopify-dev-mcp":{}}'
mkbase() {
  local servers="$BASE_SERVERS"
  if [ -n "${2:-}" ]; then servers="$2"; fi
  mkdir -p "$1/.claude-plugin"
  printf '{"name":"base","version":"0.3.0","mcpServers":%s}\n' "$servers" > "$1/.claude-plugin/plugin.json"
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

installed() { printf '{"version":2,"plugins":{%s}}' "$1"; }
base_user() { printf '"base@domaine":[{"scope":"user","version":"0.3.0","installPath":"%s"}]' "$1"; }
SECRET="shpat_fixture_never_printed"

P="$TMP/plugin"; mkplugin "$P"
B="$TMP/base-root"; mkbase "$B"
H="$TMP/home"; mkhome "$H" "$(installed "$(base_user "$B")")"
PRJ="$TMP/project"; mkdir -p "$PRJ"
printf 'SHOPIFY_ADMIN_TOKEN=%s\n' "$SECRET" > "$PRJ/.env"

# ----------------------------------------------------------------------------------- green --
run --root "$P" --home "$H" --project "$PRJ"
expect BD1-green 0 "be doctor — plugin root: $P" "PASS  node" "PASS  manifest         be 0.9.1, depends on base" \
  "PASS  scripts          3 script(s): every .sh executable, every .cjs parses" \
  "PASS  base             base@domaine 0.3.0 installed and enabled" "PASS  shopify-dev-mcp  base's manifest declares shopify-dev-mcp" \
  "PASS  event-log        $H/.claude/domaine/log: no session directory yet" "doctor: 6 passed, 0 failed, 0 skipped" "!$SECRET"

# The shipped plugin passes its own manifest and scripts rows.
run --home "$H" --project "$PRJ"
expect BD2-shipped-plugin 0 "plugin root: $ROOT/plugins/be" "PASS  manifest         be " "PASS  scripts          2 script(s)" "!FAIL"

run --root "$P" --home "$H" --project "$PRJ" --json
if "$NODE" -e '
  const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const names = j.rows.map((r) => r.name).join(",");
  if (j.root !== process.argv[2] || names !== "node,manifest,scripts,base,shopify-dev-mcp,event-log") process.exit(1);
  if (!j.rows.every((r) => ["PASS","FAIL","SKIP","WARN"].includes(r.status) && typeof r.detail === "string")) process.exit(1);
' "$O" "$P" 2>/dev/null && [ "$rc" -eq 0 ] && [ "$(wc -l < "$O" | tr -d ' ')" = "1" ]; then ok
else bad BD3-json "rc=$rc out=$(head -c 300 "$O")"; fi

# ----------------------------------------------------------------------------------- usage --
run --help; expect BD4-help 0 "usage: doctor.cjs"
run -h; expect BD4b-help-short 0 "usage: doctor.cjs"
run --bogus; if [ "$rc" -eq 2 ] && grep -q 'unknown argument --bogus' "$E"; then ok; else bad BD5-unknown-arg "rc=$rc err=$(head -c 200 "$E")"; fi
run --root; if [ "$rc" -eq 2 ] && grep -q -- '--root needs a value' "$E"; then ok; else bad BD5b-missing-value "rc=$rc"; fi

runwin --root "$P" --home "$H" --project "$PRJ"
expect BD6-windows 0 "SKIP  scripts          no exec bits or bash on native Windows"

# -------------------------------------------------------------------------------- manifest --
M="$TMP/m1"; mkplugin "$M"; rm "$M/.claude-plugin/plugin.json"
run --root "$M" --home "$H" --project "$PRJ"; expect BD7-manifest-missing 1 "FAIL  manifest         .claude-plugin/plugin.json missing — this is not a plugin root"
printf '{ not json' > "$M/.claude-plugin/plugin.json"
run --root "$M" --home "$H" --project "$PRJ"; expect BD8-manifest-invalid 1 "FAIL  manifest         .claude-plugin/plugin.json invalid JSON"
printf '{"name":"be"}' > "$M/.claude-plugin/plugin.json"
run --root "$M" --home "$H" --project "$PRJ"; expect BD9-manifest-no-version 1 'has no "version" string'
printf '{"name":"backend","version":"1.0.0","dependencies":["base"]}' > "$M/.claude-plugin/plugin.json"
run --root "$M" --home "$H" --project "$PRJ"; expect BD10-manifest-name 1 'name "backend" is not "be"'
printf '{"name":"be","version":"1.0.0","dependencies":["slim"]}' > "$M/.claude-plugin/plugin.json"
run --root "$M" --home "$H" --project "$PRJ"; expect BD11-manifest-no-base-dep 1 'version 1.0.0 does not declare base in "dependencies"'

# --------------------------------------------------------------------------------- scripts --
S="$TMP/s1"; mkplugin "$S"; chmod 644 "$S/scripts/fetch.sh"
run --root "$S" --home "$H" --project "$PRJ"
expect BD12-script-not-exec 1 "FAIL  scripts          fetch.sh not executable — chmod +x" "!_common.sh"
S2="$TMP/s2"; mkplugin "$S2"; printf "'use strict';\nconst = 1;\n" > "$S2/scripts/broken.cjs"
run --root "$S2" --home "$H" --project "$PRJ"
expect BD13-cjs-no-parse 1 "FAIL  scripts          broken.cjs does not parse: SyntaxError" "!check.cjs" "!fetch.sh"
S3="$TMP/s3"; mkdir -p "$S3/.claude-plugin" "$S3/scripts"; cp "$P/.claude-plugin/plugin.json" "$S3/.claude-plugin/"
run --root "$S3" --home "$H" --project "$PRJ"
expect BD14-no-scripts 1 "FAIL  scripts          scripts/ holds no script"
S4="$TMP/s4"; mkdir -p "$S4/.claude-plugin"; cp "$P/.claude-plugin/plugin.json" "$S4/.claude-plugin/"
run --root "$S4" --home "$H" --project "$PRJ"
expect BD14b-no-scripts-dir 1 "FAIL  scripts          scripts/ unreadable"

# ------------------------------------------------------------------------------------ base --
H2="$TMP/h-nobase"; mkhome "$H2" "$(installed '')"
run --root "$P" --home "$H2" --project "$PRJ"
expect BD15-base-absent 1 "FAIL  base             not installed" "claude plugin install base@domaine" \
  "SKIP  shopify-dev-mcp  no enabled base install to read"
H3="$TMP/h-noinstalled"; mkhome "$H3"
run --root "$P" --home "$H3" --project "$PRJ"; expect BD15b-no-install-record 1 "FAIL  base             not installed"
# The claude.ai-account copy (a cloud session, a synced terminal): no install record, enabled unless its key is false.
HS="$TMP/h-synced"; mkhome "$HS"; mkbase "$HS/.claude/plugins/synced/acc_1/base"
run --root "$P" --home "$HS" --project "$PRJ"; expect BD15c-base-synced 0 "PASS  base             base@synced 0.3.0 installed and enabled"
printf '{"enabledPlugins":{"base@synced":false}}\n' > "$HS/.claude/settings.json"
run --root "$P" --home "$HS" --project "$PRJ"; expect BD15d-base-synced-off 1 "FAIL  base             base@synced 0.3.0 is installed but disabled"
H4="$TMP/h-baseoff"; mkhome "$H4" "$(installed "$(base_user "$B")")" '{"enabledPlugins":{"base@domaine":false}}'
run --root "$P" --home "$H4" --project "$PRJ"
expect BD16-base-disabled-user 1 "FAIL  base             base@domaine 0.3.0 is installed but disabled — enable it in /plugin" \
  "SKIP  shopify-dev-mcp  no enabled base install to read"
H4b="$TMP/h-basenokey"; mkhome "$H4b" "$(installed "$(base_user "$B")")" '{}'
run --root "$P" --home "$H4b" --project "$PRJ"
expect BD16b-base-no-key 1 "FAIL  base             base@domaine 0.3.0 is installed but disabled — enable it in /plugin" \
  "SKIP  shopify-dev-mcp  no enabled base install to read"
PRJ2="$TMP/project2"; mkdir -p "$PRJ2/.claude"; printf '{"enabledPlugins":{"base@domaine":false}}\n' > "$PRJ2/.claude/settings.local.json"
run --root "$P" --home "$H" --project "$PRJ2"; expect BD17-base-disabled-project-local 1 "is installed but disabled"
BASE_PROJ="\"base@domaine\":[{\"scope\":\"project\",\"projectPath\":\"$PRJ\",\"version\":\"0.3.1\",\"installPath\":\"$B\"}]"
H5="$TMP/h-baseproj"; mkhome "$H5" "$(installed "$BASE_PROJ")"
run --root "$P" --home "$H5" --project "$PRJ"; expect BD18-base-this-project 0 "PASS  base             base@domaine 0.3.1 installed and enabled"
run --root "$P" --home "$H5" --project "$PRJ2"; expect BD19-base-other-project 1 "FAIL  base             not installed"
# CLAUDE_CONFIG_DIR stands in for ~/.claude without --home (HOME holds a base, the config dir none), and
# --home overrides it.
rc=0; HOME="$H" CLAUDE_CONFIG_DIR="$H2/.claude" PATH="/usr/bin:/bin" "$NODE" "$DOCTOR" --root "$P" --project "$PRJ" >"$O" 2>"$E" || rc=$?
expect BD20-claude-config-dir 1 "FAIL  base             not installed"
rc=0; CLAUDE_CONFIG_DIR="$H2/.claude" PATH="/usr/bin:/bin" "$NODE" "$DOCTOR" --root "$P" --home "$H" --project "$PRJ" >"$O" 2>"$E" || rc=$?
expect BD21-home-beats-config-dir 0 "PASS  base             base@domaine 0.3.0"

# ------------------------------------------------------------------------- shopify-dev-mcp --
B2="$TMP/base-nodev"; mkbase "$B2" '{"atlassian":{}}'
H6="$TMP/h-nodev"; mkhome "$H6" "$(installed "$(base_user "$B2")")"
run --root "$P" --home "$H6" --project "$PRJ"
expect BD22-dev-mcp-undeclared 1 "FAIL  shopify-dev-mcp  base's manifest (base@domaine 0.3.0) declares no shopify-dev-mcp"
B3="$TMP/base-noservers"; mkdir -p "$B3/.claude-plugin"; printf '{"name":"base","version":"0.3.0"}\n' > "$B3/.claude-plugin/plugin.json"
H7="$TMP/h-noservers"; mkhome "$H7" "$(installed "$(base_user "$B3")")"
run --root "$P" --home "$H7" --project "$PRJ"; expect BD23-dev-mcp-no-servers 1 "FAIL  shopify-dev-mcp  base's manifest (base@domaine 0.3.0) declares no shopify-dev-mcp"
H8="$TMP/h-gonebase"; mkhome "$H8" "$(installed "$(base_user "$TMP/no-such-base")")"
run --root "$P" --home "$H8" --project "$PRJ"
expect BD24-dev-mcp-manifest-unreadable 1 "PASS  base " "FAIL  shopify-dev-mcp  base's manifest unreadable at $TMP/no-such-base/.claude-plugin/plugin.json — reinstall base"
H9="$TMP/h-nopath"; mkhome "$H9" "$(installed '"base@domaine":[{"scope":"user","version":"0.3.0"}]')"
run --root "$P" --home "$H9" --project "$PRJ"
expect BD25-dev-mcp-no-install-path 1 "FAIL  shopify-dev-mcp  base's manifest unreadable (no installPath in installed_plugins.json)"

# ------------------------------------------------------------------------------- event-log --
jl() { printf '{"ts":"%s","plugin":"%s","version":"0.1.0","session":"s1","kind":"start","agent":"main","text":"x"}\n' "$2" "$1"; }
LD="$TMP/logs/s1"; mkdir -p "$LD"
{ jl be 2026-10-08T09:00:00.000Z; jl be 2026-10-08T09:05:00.000Z; } > "$LD/be.jsonl"
jl base 2026-10-08T09:07:00.000Z > "$LD/base.jsonl"
run --root "$P" --home "$H" --project "$PRJ" --log-dir "$LD"
expect BD31-event-log-session 0 "PASS  event-log        $LD/be.jsonl: 2 line(s), newest 2026-10-08T09:05:00.000Z" "!base.jsonl"
printf '{ cut mid-line\n' >> "$LD/be.jsonl"
run --root "$P" --home "$H" --project "$PRJ" --log-dir "$LD"
expect BD32-event-log-unreadable-last 0 "be.jsonl: 3 line(s), newest unreadable"
run --root "$P" --home "$H" --project "$PRJ" --log-dir "$TMP/logs/gone"
expect BD33-event-log-no-dir-yet 0 "PASS  event-log        $TMP/logs/gone: no be.jsonl line yet this session" "!warned"
mkdir -p "$TMP/logs/others"; jl band 2026-10-08T10:00:00.000Z > "$TMP/logs/others/band.jsonl"
run --root "$P" --home "$H" --project "$PRJ" --log-dir "$TMP/logs/others"
expect BD34-event-log-others-only 0 "PASS  event-log        $TMP/logs/others: no be.jsonl line yet this session"
rc=0; BE_EVENT_LOG=0 PATH="/usr/bin:/bin" "$NODE" "$DOCTOR" --root "$P" --home "$H" --project "$PRJ" --log-dir "$TMP/logs/others" >"$O" 2>"$E" || rc=$?
expect BD35-event-log-off 0 "PASS  event-log        $TMP/logs/others: be's is off (BE_EVENT_LOG=0)"
mkdir -p "$TMP/dirlog/be.jsonl"
run --root "$P" --home "$H" --project "$PRJ" --log-dir "$TMP/dirlog"
expect BD35b-event-log-unreadable 0 "WARN  event-log        $TMP/dirlog/be.jsonl unreadable" ", 1 warned"
# By hand (no --log-dir): the newest session directory under <home>/.claude/domaine/log, a link never followed.
HL="$TMP/h-logs"; mkhome "$HL" "$(installed "$(base_user "$B")")"; R="$HL/.claude/domaine/log"
mkdir -p "$R/old" "$R/new"; jl be 2026-10-01T00:00:00.000Z > "$R/old/be.jsonl"; jl be 2026-10-08T00:00:00.000Z > "$R/new/be.jsonl"
touch -t 202010010000 "$R/old/be.jsonl" "$R/old"
mkdir -p "$TMP/elsewhere-log"; jl be 2026-10-09T00:00:00.000Z > "$TMP/elsewhere-log/be.jsonl"; ln -s "$TMP/elsewhere-log" "$R/zlink"
run --root "$P" --home "$HL" --project "$PRJ"
expect BD36-event-log-newest-by-hand 0 "PASS  event-log        $R/new/be.jsonl: 1 line(s), newest 2026-10-08T00:00:00.000Z" "!elsewhere-log"
rc=0; DOMAINE_LOG_DIR="$TMP/logs" PATH="/usr/bin:/bin" "$NODE" "$DOCTOR" --root "$P" --home "$HL" --project "$PRJ" >"$O" 2>"$E" || rc=$?
expect BD37-event-log-override 0 "PASS  event-log        $TMP/logs/" "!$R"
rc=0; DOMAINE_LOG_DIR=relative/logs PATH="/usr/bin:/bin" "$NODE" "$DOCTOR" --root "$P" --home "$HL" --project "$PRJ" >"$O" 2>"$E" || rc=$?
expect BD38-event-log-relative-override-ignored 0 "PASS  event-log        $R/new/be.jsonl"

# No run printed the project's secret, on stdout or stderr.
run --root "$P" --home "$H" --project "$PRJ" --json
if ! grep -qF "$SECRET" "$O" "$E"; then ok; else bad BD39-no-secret "a doctor run printed the .env value"; fi

# The suite never touched the real checkout.
if [ "$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo none)" = "$HEAD_BEFORE" ]; then ok; else bad BD-head "HEAD moved"; fi

echo "be-doctor-sim: $pass passed, $fail failed"
if [ "$fail" -gt 0 ]; then printf '%s' "$failures"; exit 1; fi
