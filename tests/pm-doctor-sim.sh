#!/usr/bin/env bash
# Simulation harness for plugins/pm/scripts/doctor.cjs: every case runs the doctor against a sandbox plugin
# root (--root), a sandbox home (--home) whose install record points at a sandbox base, and a sandbox project
# (--project). No host, no network, nothing written outside $TMPDIR. The session rows (base loaded, slim's
# view tool) are the mod's and live in plugins/pm/hooks/mods/tests/doctor.test.ts.
# Exit 0 = all green.
set -u
unset CLAUDE_CONFIG_DIR DOMAINE_LOG_DIR PM_EVENT_LOG

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DOCTOR="$ROOT/plugins/pm/scripts/doctor.cjs"
NODE="$(command -v node)"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
HEAD_BEFORE="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo none)"
O="$TMP/out"; E="$TMP/err"

pass=0; fail=0; failures=""
ok() { pass=$((pass + 1)); }
bad() { fail=$((fail + 1)); failures="${failures}  [$1] $2
"; }

PATHS="/usr/bin:/bin"
rc=0
run() { rc=0; PATH="$PATHS" "$NODE" "$DOCTOR" "$@" >"$O" 2>"$E" || rc=$?; }
WIN_SHIM="$TMP/as-win32.cjs"
printf "Object.defineProperty(process, 'platform', { value: 'win32' });\n" > "$WIN_SHIM"
runwin() { rc=0; PATH="$PATHS" "$NODE" --require "$WIN_SHIM" "$DOCTOR" "$@" >"$O" 2>"$E" || rc=$?; }

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

SECRET="sk_fixture_never_printed"

# mkplugin <dir> — a plugin root that passes the manifest and scripts rows: one .cjs that parses, one
# executable .sh that answers --help, and a sourced `_*.sh` that is neither.
mkplugin() {
  local d="$1"
  mkdir -p "$d/.claude-plugin" "$d/scripts"
  printf '{"name":"pm","version":"0.9.1","dependencies":["base"]}\n' > "$d/.claude-plugin/plugin.json"
  printf "'use strict';\nmodule.exports = 1;\n" > "$d/scripts/tool.cjs"
  printf '#!/bin/sh\n[ "${1:-}" = --help ] && { echo "usage: fetch.sh"; exit 0; }\nexit 0\n' > "$d/scripts/fetch.sh"; chmod 755 "$d/scripts/fetch.sh"
  printf 'trim_ws() { :; }\n' > "$d/scripts/_common.sh"; chmod 644 "$d/scripts/_common.sh"
}

# mkbase <dir> <servers-json> — a base install path whose manifest declares <servers-json> as mcpServers.
mkbase() {
  mkdir -p "$1/.claude-plugin"
  printf '{"name":"base","version":"0.3.1","mcpServers":%s}\n' "$2" > "$1/.claude-plugin/plugin.json"
}

# mkhome <dir> [installed-json] [settings-json] — a home with `.claude/plugins/installed_plugins.json`.
mkhome() {
  local d="$1"
  mkdir -p "$d/.claude/plugins"
  if [ -n "${2:-}" ]; then printf '%s\n' "$2" > "$d/.claude/plugins/installed_plugins.json"; fi
  # No settings given → every plugin a fixture installs is enabled, as `claude plugin install` writes it.
  local settings="${3:-}"
  [ -n "$settings" ] || settings='{"enabledPlugins":{"slim@domaine":true,"base@domaine":true,"fnd@domaine":true}}'
  printf '%s\n' "$settings" > "$d/.claude/settings.json"
}
installed() { printf '{"version":2,"plugins":{%s}}' "$1"; }
base_user() { printf '"base@domaine":[{"scope":"user","installPath":"%s","version":"0.3.1"}]' "$1"; }

BASEDIR="$TMP/base-install"
mkbase "$BASEDIR" "{\"atlassian\":{\"command\":\"npx\"},\"notion-mcp\":{\"type\":\"http\",\"env\":{\"TOKEN\":\"$SECRET\"}},\"playwright\":{}}"
P="$TMP/plugin"; mkplugin "$P"
H="$TMP/home"; mkhome "$H" "$(installed "$(base_user "$BASEDIR")")"
PRJ="$TMP/project"; mkdir -p "$PRJ"; printf 'API_TOKEN=%s\n' "$SECRET" > "$PRJ/.env"

# ----------------------------------------------------------------------------------- green --
run --root "$P" --home "$H" --project "$PRJ"
expect PD1-green 0 "pm doctor — plugin root: $P" "PASS  node" "PASS  manifest    pm 0.9.1, depends on base" \
  "PASS  scripts     1 .cjs parse; 1 .sh executable, each answers --help" \
  "PASS  base        base@domaine 0.3.1 installed and enabled" \
  "PASS  atlassian   declared in base's manifest (base@domaine 0.3.1)" \
  "PASS  notion-mcp  declared in base's manifest (base@domaine 0.3.1)" \
  "PASS  event-log   $H/.claude/domaine/log: no session directory yet" "doctor: 7 passed, 0 failed, 0 skipped" "!$SECRET" "!_common.sh"

# The shipped plugin passes its own manifest and scripts rows.
run --home "$H" --project "$PRJ"
expect PD2-shipped-plugin 0 "plugin root: $ROOT/plugins/pm" "PASS  manifest    pm " "PASS  scripts     1 .cjs parse" "!FAIL"

run --root "$P" --home "$H" --project "$PRJ" --json
if "$NODE" -e '
  const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const names = j.rows.map((r) => r.name).join(",");
  if (j.root !== process.argv[2] || names !== "node,manifest,scripts,base,atlassian,notion-mcp,event-log") process.exit(1);
  if (!j.rows.every((r) => ["PASS","FAIL","SKIP","WARN"].includes(r.status) && typeof r.detail === "string")) process.exit(1);
' "$O" "$P" 2>/dev/null && [ "$rc" -eq 0 ] && [ "$(wc -l < "$O" | tr -d ' ')" = "1" ] && ! grep -qF "$SECRET" "$O"; then ok
else bad PD3-json "rc=$rc out=$(head -c 300 "$O")"; fi

# ----------------------------------------------------------------------------------- usage --
run --help; expect PD4-help 0 "usage: doctor.cjs"
run --bogus; if [ "$rc" -eq 2 ] && grep -q 'unknown argument --bogus' "$E"; then ok; else bad PD5-unknown-arg "rc=$rc err=$(head -c 200 "$E")"; fi
run --root; if [ "$rc" -eq 2 ] && grep -q -- '--root needs a value' "$E"; then ok; else bad PD5b-missing-value "rc=$rc"; fi

runwin --root "$P" --home "$H" --project "$PRJ"
expect PD6-windows 0 "PASS  scripts     1 .cjs parse; 1 .sh not probed — no exec bits or bash on native Windows"

# -------------------------------------------------------------------------------- manifest --
M="$TMP/m1"; mkplugin "$M"; rm "$M/.claude-plugin/plugin.json"
run --root "$M" --home "$H" --project "$PRJ"; expect PD7-manifest-missing 1 "FAIL  manifest    .claude-plugin/plugin.json missing — this is not a plugin root"
printf '{ not json' > "$M/.claude-plugin/plugin.json"
run --root "$M" --home "$H" --project "$PRJ"; expect PD8-manifest-invalid 1 "FAIL  manifest    .claude-plugin/plugin.json invalid JSON"
printf '{"name":"pm"}' > "$M/.claude-plugin/plugin.json"
run --root "$M" --home "$H" --project "$PRJ"; expect PD9-manifest-no-version 1 'has no "version" string'
printf '{"name":"project-mgmt","version":"1.0.0","dependencies":["base"]}' > "$M/.claude-plugin/plugin.json"
run --root "$M" --home "$H" --project "$PRJ"; expect PD10-manifest-name 1 'name "project-mgmt" is not "pm"'
printf '{"name":"pm","version":"1.0.0","dependencies":["slim"]}' > "$M/.claude-plugin/plugin.json"
run --root "$M" --home "$H" --project "$PRJ"; expect PD11-manifest-no-base-dep 1 'version 1.0.0 does not declare base in "dependencies"'

# --------------------------------------------------------------------------------- scripts --
S="$TMP/s1"; mkplugin "$S"; chmod 644 "$S/scripts/fetch.sh"
run --root "$S" --home "$H" --project "$PRJ"
expect PD12-script-not-exec 1 "FAIL  scripts     fetch.sh not executable — chmod +x" "!_common.sh"
S2="$TMP/s2"; mkplugin "$S2"
printf '#!/bin/sh\necho "nope: unknown flag" >&2\nexit 3\n' > "$S2/scripts/broken.sh"; chmod 755 "$S2/scripts/broken.sh"
run --root "$S2" --home "$H" --project "$PRJ"
expect PD13-script-no-help 1 "FAIL  scripts     broken.sh --help exited 3: nope: unknown flag" "!fetch.sh"
S3="$TMP/s3"; mkplugin "$S3"; printf 'module.exports = {\n' > "$S3/scripts/half.cjs"
run --root "$S3" --home "$H" --project "$PRJ"
expect PD14-cjs-no-parse 1 "FAIL  scripts     half.cjs does not parse: SyntaxError: " "!tool.cjs"
S4="$TMP/s4"; mkdir -p "$S4/.claude-plugin" "$S4/scripts"; cp "$P/.claude-plugin/plugin.json" "$S4/.claude-plugin/"
run --root "$S4" --home "$H" --project "$PRJ"
expect PD15-no-scripts 1 "FAIL  scripts     scripts/ is empty — doctor.cjs belongs there"
rmdir "$S4/scripts"
run --root "$S4" --home "$H" --project "$PRJ"
expect PD15b-scripts-dir-missing 1 "FAIL  scripts     scripts/ unreadable"

# ------------------------------------------------------------------------------------ base --
H2="$TMP/h-nobase"; mkhome "$H2" "$(installed '')"
run --root "$P" --home "$H2" --project "$PRJ"
expect PD16-base-absent 1 "FAIL  base        not installed" "claude plugin install base@domaine" \
  "SKIP  atlassian   no enabled base install to read — the base row says why" "SKIP  notion-mcp  no enabled base install to read — the base row says why"
H3="$TMP/h-noinstalled"; mkhome "$H3"
run --root "$P" --home "$H3" --project "$PRJ"; expect PD17-no-install-record 1 "FAIL  base        not installed"
H4="$TMP/h-baseoff"; mkhome "$H4" "$(installed "$(base_user "$BASEDIR")")" '{"enabledPlugins":{"base@domaine":false}}'
run --root "$P" --home "$H4" --project "$PRJ"
expect PD18-base-disabled-user 1 "FAIL  base        base@domaine 0.3.1 is installed but disabled — enable it in /plugin" \
  "SKIP  atlassian   no enabled base install to read" "SKIP  notion-mcp  no enabled base install to read"
PRJ2=  "SKIP  atlassian   no enabled base install to read" "SKIP  notion-mcp  no enabled base install to read"
H4b="$TMP/h-basenokey"; mkhome "$H4b" "$(installed "$(base_user "$BASEDIR")")" '{}'
run --root "$P" --home "$H4b" --project "$PRJ"
expect PD18b-base-no-key 1 "FAIL  base        base@domaine 0.3.1 is installed but disabled — enable it in /plugin" \
  "SKIP  atlassian   no enabled base install to read" "SKIP  notion-mcp  no enabled base install to read"
PRJ2="$TMP/project2"; mkdir -p "$PRJ2/.claude"; printf '{"enabledPlugins":{"base@domaine":false}}\n' > "$PRJ2/.claude/settings.local.json"
run --root "$P" --home "$H" --project "$PRJ2"; expect PD19-base-disabled-project-local 1 "is installed but disabled"
BASE_PROJ="\"base@domaine\":[{\"scope\":\"project\",\"projectPath\":\"$PRJ\",\"installPath\":\"$BASEDIR\",\"version\":\"0.3.2\"}]"
H5="$TMP/h-baseproj"; mkhome "$H5" "$(installed "$BASE_PROJ")"
run --root "$P" --home "$H5" --project "$PRJ"; expect PD20-base-this-project 0 "PASS  base        base@domaine 0.3.2 installed and enabled"
run --root "$P" --home "$H5" --project "$PRJ2"; expect PD21-base-other-project 1 "FAIL  base        not installed"
# CLAUDE_CONFIG_DIR stands in for ~/.claude without --home, and --home overrides it; the config dir's base
# carries a version no real install has, so the developer's own ~/.claude cannot answer for it.
HC="$TMP/h-configdir"; mkhome "$HC" "$(installed '"base@domaine":[{"scope":"user","installPath":"'"$BASEDIR"'","version":"7.7.7-fixture"}]')"
rc=0; CLAUDE_CONFIG_DIR="$HC/.claude" PATH="$PATHS" "$NODE" "$DOCTOR" --root "$P" --project "$PRJ" >"$O" 2>"$E" || rc=$?
expect PD22-claude-config-dir 0 "PASS  base        base@domaine 7.7.7-fixture installed and enabled"
rc=0; CLAUDE_CONFIG_DIR="$H2/.claude" PATH="$PATHS" "$NODE" "$DOCTOR" --root "$P" --home "$H" --project "$PRJ" >"$O" 2>"$E" || rc=$?
expect PD23-home-beats-config-dir 0 "PASS  base        base@domaine 0.3.1"

# ------------------------------------------------------------------------- base's servers --
B2="$TMP/base-noatl"; mkbase "$B2" '{"notion-mcp":{}}'
H6="$TMP/h-noatl"; mkhome "$H6" "$(installed "$(base_user "$B2")")"
run --root "$P" --home "$H6" --project "$PRJ"
expect PD24-atlassian-undeclared 1 "FAIL  atlassian   not declared in base's manifest (base@domaine 0.3.1) — pm reaches it only through base: update base" \
  "PASS  notion-mcp  declared in base's manifest"
B3="$TMP/base-noservers"; mkdir -p "$B3/.claude-plugin"; printf '{"name":"base","version":"0.3.1"}\n' > "$B3/.claude-plugin/plugin.json"
H7="$TMP/h-noservers"; mkhome "$H7" "$(installed "$(base_user "$B3")")"
run --root "$P" --home "$H7" --project "$PRJ"
expect PD25-no-servers-key 1 "FAIL  atlassian   not declared" "FAIL  notion-mcp  not declared"
H8="$TMP/h-gone"; mkhome "$H8" "$(installed "$(base_user "$TMP/nowhere")")"
run --root "$P" --home "$H8" --project "$PRJ"
expect PD26-base-manifest-unreadable 1 "FAIL  atlassian   base's manifest unreadable at $TMP/nowhere/.claude-plugin/plugin.json — reinstall base" "FAIL  notion-mcp  base's manifest unreadable"
H9="$TMP/h-nopath"; mkhome "$H9" "$(installed '"base@domaine":[{"scope":"user","version":"0.3.1"}]')"
run --root "$P" --home "$H9" --project "$PRJ"
expect PD27-no-install-path 1 "FAIL  atlassian   base's manifest unreadable (no installPath in installed_plugins.json) — reinstall base"

# ------------------------------------------------------------------------------- event-log --
jl() { printf '{"ts":"%s","plugin":"%s","version":"0.1.0","session":"s1","kind":"start","agent":"main","text":"x"}\n' "$2" "$1"; }
LD="$TMP/logs/s1"; mkdir -p "$LD"
{ jl pm 2026-10-08T09:00:00.000Z; jl pm 2026-10-08T09:05:00.000Z; } > "$LD/pm.jsonl"
jl base 2026-10-08T09:07:00.000Z > "$LD/base.jsonl"
run --root "$P" --home "$H" --project "$PRJ" --log-dir "$LD"
expect PD28-event-log-session 0 "PASS  event-log   $LD/pm.jsonl: 2 line(s), newest 2026-10-08T09:05:00.000Z" "!base.jsonl"
printf '{ cut mid-line\n' >> "$LD/pm.jsonl"
run --root "$P" --home "$H" --project "$PRJ" --log-dir "$LD"
expect PD29-event-log-unreadable-last 0 "pm.jsonl: 3 line(s), newest unreadable"
# A /clear's new id has no directory before its first line, and a session may have only others' files: not a failure.
run --root "$P" --home "$H" --project "$PRJ" --log-dir "$TMP/logs/gone"
expect PD30-event-log-no-dir-yet 0 "PASS  event-log   $TMP/logs/gone: no pm.jsonl line yet this session" "!warned"
mkdir -p "$TMP/logs/others"; jl band 2026-10-08T10:00:00.000Z > "$TMP/logs/others/band.jsonl"
run --root "$P" --home "$H" --project "$PRJ" --log-dir "$TMP/logs/others"
expect PD31-event-log-others-only 0 "PASS  event-log   $TMP/logs/others: no pm.jsonl line yet this session"
rc=0; PM_EVENT_LOG=0 PATH="$PATHS" "$NODE" "$DOCTOR" --root "$P" --home "$H" --project "$PRJ" --log-dir "$TMP/logs/others" >"$O" 2>"$E" || rc=$?
expect PD32-event-log-off 0 "PASS  event-log   $TMP/logs/others: pm's is off (PM_EVENT_LOG=0)"
mkdir -p "$TMP/logs2/dirfile/pm.jsonl"
run --root "$P" --home "$H" --project "$PRJ" --log-dir "$TMP/logs2/dirfile"
expect PD33-event-log-unreadable 0 "WARN  event-log   $TMP/logs2/dirfile/pm.jsonl unreadable" ", 1 warned"
# By hand (no --log-dir): the newest session directory under <home>/.claude/domaine/log, a link never followed.
HL="$TMP/h-logs"; mkhome "$HL" "$(installed "$(base_user "$BASEDIR")")"; R="$HL/.claude/domaine/log"
# the older directory sorts first, so a doctor that took the first listed one fails here
mkdir -p "$R/a-old" "$R/b-new"; jl pm 2026-10-01T00:00:00.000Z > "$R/a-old/pm.jsonl"; jl pm 2026-10-08T00:00:00.000Z > "$R/b-new/pm.jsonl"
touch -t 202010010000 "$R/a-old/pm.jsonl" "$R/a-old"
mkdir -p "$TMP/elsewhere-log"; jl pm 2026-10-09T00:00:00.000Z > "$TMP/elsewhere-log/pm.jsonl"; ln -s "$TMP/elsewhere-log" "$R/zlink"
run --root "$P" --home "$HL" --project "$PRJ"
expect PD34-event-log-newest-by-hand 0 "PASS  event-log   $R/b-new/pm.jsonl: 1 line(s), newest 2026-10-08T00:00:00.000Z" "!elsewhere-log"
rc=0; DOMAINE_LOG_DIR="$TMP/logs" PATH="$PATHS" "$NODE" "$DOCTOR" --root "$P" --home "$HL" --project "$PRJ" >"$O" 2>"$E" || rc=$?
expect PD35-event-log-override 0 "PASS  event-log   $TMP/logs/" "!$R"
rc=0; DOMAINE_LOG_DIR=relative/logs PATH="$PATHS" "$NODE" "$DOCTOR" --root "$P" --home "$HL" --project "$PRJ" >"$O" 2>"$E" || rc=$?
expect PD36-event-log-relative-override-ignored 0 "PASS  event-log   $R/b-new/pm.jsonl"

# No run printed the planted secret, on stdout or stderr.
if ! grep -rqF "$SECRET" "$O" "$E"; then ok; else bad PD-secret "the planted secret reached the output"; fi

# The suite never touched the real checkout.
if [ "$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo none)" = "$HEAD_BEFORE" ]; then ok; else bad PD-head "HEAD moved"; fi

echo "pm-doctor-sim: $pass passed, $fail failed"
if [ "$fail" -gt 0 ]; then printf '%s' "$failures"; exit 1; fi
