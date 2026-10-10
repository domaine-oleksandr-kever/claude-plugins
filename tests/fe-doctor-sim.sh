#!/usr/bin/env bash
# Simulation harness for plugins/fe/scripts/doctor.cjs: every case runs the doctor against a sandbox plugin
# root (--root), a sandbox home (--home), a sandbox project (--project) and a PATH whose `shopify` is a stub
# or absent. No host, no network, nothing written outside $TMPDIR. The session rows (base loaded, slim's
# view tool, the session's profile) are the mod's and live in plugins/fe/hooks/mods/tests/doctor.test.ts.
# Exit 0 = all green.
set -u
unset CLAUDE_CONFIG_DIR DOMAINE_LOG_DIR FE_EVENT_LOG FE_PROFILE

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DOCTOR="$ROOT/plugins/fe/scripts/doctor.cjs"
NODE="$(command -v node)"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
HEAD_BEFORE="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo none)"
O="$TMP/out"; E="$TMP/err"

pass=0; fail=0; failures=""
ok() { pass=$((pass + 1)); }
bad() { fail=$((fail + 1)); failures="${failures}  [$1] $2
"; }

# A PATH with a `shopify` stub and one without: bash and the coreutils only, never the developer's own CLI.
SHOPBIN="$TMP/shopbin"; mkdir -p "$SHOPBIN"
printf '#!/bin/sh\necho "3.66.1"\n' > "$SHOPBIN/shopify"; chmod 755 "$SHOPBIN/shopify"
BADSHOP="$TMP/badshop"; mkdir -p "$BADSHOP"
printf '#!/bin/sh\necho "Error: node too old" >&2\nexit 1\n' > "$BADSHOP/shopify"; chmod 755 "$BADSHOP/shopify"
WITH_SHOP="$SHOPBIN:/usr/bin:/bin"
NO_SHOP="/usr/bin:/bin"

rc=0
# run [--path <PATH>] <doctor args...> — PATH defaults to the one with the stub.
run() {
  local p="$WITH_SHOP"
  if [ "${1:-}" = --path ]; then p="$2"; shift 2; fi
  rc=0; PATH="$p" "$NODE" "$DOCTOR" "$@" >"$O" 2>"$E" || rc=$?
}
WIN_SHIM="$TMP/as-win32.cjs"
printf "Object.defineProperty(process, 'platform', { value: 'win32' });\n" > "$WIN_SHIM"
runwin() { rc=0; PATH="$WITH_SHOP" "$NODE" --require "$WIN_SHIM" "$DOCTOR" "$@" >"$O" 2>"$E" || rc=$?; }

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

# mkplugin <dir> — a plugin root that passes the manifest and scripts rows; its profile probe answers
# `theme` for a directory holding layout/theme.liquid, else `none`, and has no --help (as the real one).
mkplugin() {
  local d="$1"
  mkdir -p "$d/.claude-plugin" "$d/scripts"
  printf '{"name":"fe","version":"0.9.1","dependencies":["base"]}\n' > "$d/.claude-plugin/plugin.json"
  printf '#!/bin/sh\n[ "${1:-}" = --help ] && { echo "usage: fetch.sh"; exit 0; }\nexit 0\n' > "$d/scripts/fetch.sh"; chmod 755 "$d/scripts/fetch.sh"
  printf 'trim_ws() { :; }\n' > "$d/scripts/_common.sh"; chmod 644 "$d/scripts/_common.sh"
  printf '#!/bin/sh\n[ -d "$1" ] || { echo "error=no_such_dir dir=$1" >&2; exit 2; }\n[ -f "$1/layout/theme.liquid" ] && echo theme || echo none\n' > "$d/scripts/project-profile.sh"
  chmod 755 "$d/scripts/project-profile.sh"
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

BASE_USER='"base@domaine":[{"scope":"user","version":"0.2.0"}]'
installed() { printf '{"version":2,"plugins":{%s}}' "$1"; }
SECRET="shpat_fixture_never_printed"

P="$TMP/plugin"; mkplugin "$P"
H="$TMP/home"; mkhome "$H" "$(installed "$BASE_USER")"
PRJ="$TMP/project"; mkdir -p "$PRJ/layout"; : > "$PRJ/layout/theme.liquid"
printf 'SHOPIFY_CLI_THEME_TOKEN=%s\n' "$SECRET" > "$PRJ/.env"
printf '[environments.development]\nstore = "fixture-store.example"\npassword = "%s"\n' "$SECRET" > "$PRJ/shopify.theme.toml"
BARE="$TMP/bare"; mkdir -p "$BARE"

# ----------------------------------------------------------------------------------- green --
run --root "$P" --home "$H" --project "$PRJ"
expect FD1-green 0 "fe doctor — plugin root: $P" "PASS  node" "PASS  manifest      fe 0.9.1, depends on base" \
  "PASS  scripts       2 shell script(s) executable, each answers --help" \
  "PASS  base          base@domaine 0.2.0 installed and enabled" "PASS  shopify-cli   shopify 3.66.1" \
  "PASS  profile       theme (project-profile.sh)" "PASS  store-config  shopify.theme.toml and .env present (values not read)" \
  "PASS  event-log     $H/.claude/domaine/log: no session directory yet" "doctor: 8 passed, 0 failed, 0 skipped" "!$SECRET" "!fixture-store"

# The shipped plugin passes its own manifest and scripts rows: every script it ships answers --help.
run --home "$H" --project "$PRJ"
expect FD2-shipped-plugin 0 "plugin root: $ROOT/plugins/fe" "PASS  manifest      fe " "PASS  scripts       " "PASS  profile       theme (project-profile.sh)" "!FAIL"

run --root "$P" --home "$H" --project "$PRJ" --json
if "$NODE" -e '
  const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const names = j.rows.map((r) => r.name).join(",");
  if (j.root !== process.argv[2] || names !== "node,manifest,scripts,base,shopify-cli,profile,store-config,event-log") process.exit(1);
  if (!j.rows.every((r) => ["PASS","FAIL","SKIP","WARN"].includes(r.status) && typeof r.detail === "string")) process.exit(1);
' "$O" "$P" 2>/dev/null && [ "$rc" -eq 0 ] && [ "$(wc -l < "$O" | tr -d ' ')" = "1" ]; then ok
else bad FD3-json "rc=$rc out=$(head -c 300 "$O")"; fi

# ----------------------------------------------------------------------------------- usage --
run --help; expect FD4-help 0 "usage: doctor.cjs"
run --bogus; if [ "$rc" -eq 2 ] && grep -q 'unknown argument --bogus' "$E"; then ok; else bad FD5-unknown-arg "rc=$rc err=$(head -c 200 "$E")"; fi
run --root; if [ "$rc" -eq 2 ] && grep -q -- '--root needs a value' "$E"; then ok; else bad FD5b-missing-value "rc=$rc"; fi

runwin --root "$P" --home "$H" --project "$PRJ"
expect FD6-windows 0 "SKIP  scripts       no exec bits or bash on native Windows"

# -------------------------------------------------------------------------------- manifest --
M="$TMP/m1"; mkplugin "$M"; rm "$M/.claude-plugin/plugin.json"
run --root "$M" --home "$H" --project "$PRJ"; expect FD7-manifest-missing 1 "FAIL  manifest      .claude-plugin/plugin.json missing — this is not a plugin root"
printf '{ not json' > "$M/.claude-plugin/plugin.json"
run --root "$M" --home "$H" --project "$PRJ"; expect FD8-manifest-invalid 1 "FAIL  manifest      .claude-plugin/plugin.json invalid JSON"
printf '{"name":"fe"}' > "$M/.claude-plugin/plugin.json"
run --root "$M" --home "$H" --project "$PRJ"; expect FD9-manifest-no-version 1 'has no "version" string'
printf '{"name":"frontend","version":"1.0.0","dependencies":["base"]}' > "$M/.claude-plugin/plugin.json"
run --root "$M" --home "$H" --project "$PRJ"; expect FD10-manifest-name 1 'name "frontend" is not "fe"'
printf '{"name":"fe","version":"1.0.0","dependencies":["slim"]}' > "$M/.claude-plugin/plugin.json"
run --root "$M" --home "$H" --project "$PRJ"; expect FD11-manifest-no-base-dep 1 'version 1.0.0 does not declare base in "dependencies"'

# --------------------------------------------------------------------------------- scripts --
S="$TMP/s1"; mkplugin "$S"; chmod 644 "$S/scripts/fetch.sh"
run --root "$S" --home "$H" --project "$PRJ"
expect FD12-script-not-exec 1 "FAIL  scripts       fetch.sh not executable — chmod +x" "!_common.sh"
S2="$TMP/s2"; mkplugin "$S2"
printf '#!/bin/sh\necho "nope: unknown flag" >&2\nexit 3\n' > "$S2/scripts/broken.sh"; chmod 755 "$S2/scripts/broken.sh"
run --root "$S2" --home "$H" --project "$PRJ"
expect FD13-script-no-help 1 "FAIL  scripts       broken.sh --help exited 3: nope: unknown flag" "!fetch.sh" "!project-profile.sh --help"
S3="$TMP/s3"; mkdir -p "$S3/.claude-plugin" "$S3/scripts"; cp "$P/.claude-plugin/plugin.json" "$S3/.claude-plugin/"
run --root "$S3" --home "$H" --project "$PRJ"
expect FD14-no-scripts 1 "FAIL  scripts       scripts/ holds no shell script"

# ------------------------------------------------------------------------------------ base --
H2="$TMP/h-nobase"; mkhome "$H2" "$(installed '')"
run --root "$P" --home "$H2" --project "$PRJ"
expect FD15-base-absent 1 "FAIL  base          not installed" "claude plugin install base@domaine"
H3="$TMP/h-noinstalled"; mkhome "$H3"
run --root "$P" --home "$H3" --project "$PRJ"; expect FD15b-no-install-record 1 "FAIL  base          not installed"
# The claude.ai-account copy (a cloud session, a synced terminal): no install record, enabled unless its key is false.
HS="$TMP/h-synced"; mkhome "$HS"; SB="$HS/.claude/plugins/synced/acc_1/base"; mkdir -p "$SB/.claude-plugin" "$SB/scripts"
printf '{"name":"base","version":"0.8.0"}\n' > "$SB/.claude-plugin/plugin.json"; : > "$SB/scripts/review-scope.sh"
run --root "$P" --home "$HS" --project "$PRJ"; expect FD15c-base-synced 0 "PASS  base          base@synced 0.8.0 installed and enabled"
printf '{"enabledPlugins":{"base@synced":false}}\n' > "$HS/.claude/settings.json"
run --root "$P" --home "$HS" --project "$PRJ"; expect FD15d-base-synced-off 1 "FAIL  base          base@synced 0.8.0 is installed but disabled"
H4="$TMP/h-baseoff"; mkhome "$H4" "$(installed "$BASE_USER")" '{"enabledPlugins":{"base@domaine":false}}'
run --root "$P" --home "$H4" --project "$PRJ"
expect FD16-base-disabled-user 1 "FAIL  base          base@domaine 0.2.0 is installed but disabled — enable it in /plugin"
H4b="$TMP/h-basenokey"; mkhome "$H4b" "$(installed "$BASE_USER")" '{}'
run --root "$P" --home "$H4b" --project "$PRJ"
expect FD16b-base-no-key 1 "FAIL  base          base@domaine 0.2.0 is installed but disabled — enable it in /plugin"
PRJ2="$TMP/project2"; mkdir -p "$PRJ2/.claude"; printf '{"enabledPlugins":{"base@domaine":false}}\n' > "$PRJ2/.claude/settings.local.json"
run --root "$P" --home "$H" --project "$PRJ2"; expect FD17-base-disabled-project-local 1 "is installed but disabled"
BASE_PROJ="\"base@domaine\":[{\"scope\":\"project\",\"projectPath\":\"$PRJ\",\"version\":\"0.2.1\"}]"
H5="$TMP/h-baseproj"; mkhome "$H5" "$(installed "$BASE_PROJ")"
run --root "$P" --home "$H5" --project "$PRJ"; expect FD18-base-this-project 0 "PASS  base          base@domaine 0.2.1 installed and enabled"
run --root "$P" --home "$H5" --project "$PRJ2"; expect FD19-base-other-project 1 "FAIL  base          not installed"
# CLAUDE_CONFIG_DIR stands in for ~/.claude without --home, and --home overrides it.
rc=0; CLAUDE_CONFIG_DIR="$H2/.claude" PATH="$WITH_SHOP" "$NODE" "$DOCTOR" --root "$P" --project "$PRJ" >"$O" 2>"$E" || rc=$?
expect FD20-claude-config-dir 1 "FAIL  base          not installed"
rc=0; CLAUDE_CONFIG_DIR="$H2/.claude" PATH="$WITH_SHOP" "$NODE" "$DOCTOR" --root "$P" --home "$H" --project "$PRJ" >"$O" 2>"$E" || rc=$?
expect FD21-home-beats-config-dir 0 "PASS  base          base@domaine 0.2.0"
# An install path without the review-scope script fe's PR gate runs is an outdated base.
OLDBASE="$TMP/base-old"; mkdir -p "$OLDBASE/scripts"
BASE_OLD="\"base@domaine\":[{\"scope\":\"user\",\"version\":\"0.7.3\",\"installPath\":\"$OLDBASE\"}]"
H6="$TMP/h-baseold"; mkhome "$H6" "$(installed "$BASE_OLD")"
run --root "$P" --home "$H6" --project "$PRJ"
expect FD21b-base-outdated 1 "FAIL  base          base@domaine 0.7.3 has no scripts/review-scope.sh" "claude plugin update base@domaine"
: > "$OLDBASE/scripts/review-scope.sh"
run --root "$P" --home "$H6" --project "$PRJ"; expect FD21c-base-current 0 "PASS  base          base@domaine 0.7.3 installed and enabled"

# ----------------------------------------------------------------------------- shopify-cli --
run --path "$NO_SHOP" --root "$P" --home "$H" --project "$PRJ"
expect FD22-shopify-absent 0 "WARN  shopify-cli   shopify is not on PATH" "npm install -g @shopify/cli" ", 1 warned"
run --path "$BADSHOP:/usr/bin:/bin" --root "$P" --home "$H" --project "$PRJ"
expect FD23-shopify-failing 0 "WARN  shopify-cli   shopify version exited 1: Error: node too old"

# --------------------------------------------------------------------------------- profile --
rc=0; FE_PROFILE=foundation PATH="$WITH_SHOP" "$NODE" "$DOCTOR" --root "$P" --home "$H" --project "$BARE" >"$O" 2>"$E" || rc=$?
expect FD24-profile-forced 0 "PASS  profile       foundation (FE_PROFILE)" "WARN  store-config  shopify.theme.toml and .env absent in $BARE"
rc=0; FE_PROFILE=Foundation PATH="$WITH_SHOP" "$NODE" "$DOCTOR" --root "$P" --home "$H" --project "$PRJ" >"$O" 2>"$E" || rc=$?
expect FD25-profile-bad-word-probes 0 "PASS  profile       theme (project-profile.sh)"
PP="$TMP/pp"; mkplugin "$PP"; rm "$PP/scripts/project-profile.sh"
run --root "$PP" --home "$H" --project "$PRJ"
expect FD26-profile-script-missing 1 "FAIL  profile       scripts/project-profile.sh missing — fe falls back to none"
PQ="$TMP/pq"; mkplugin "$PQ"; printf '#!/bin/sh\necho shopify\n' > "$PQ/scripts/project-profile.sh"
run --root "$PQ" --home "$H" --project "$PRJ"
expect FD27-profile-bad-answer 0 "WARN  profile       none (fallback: project-profile.sh exited 0: shopify)"

# ---------------------------------------------------------------------------- store-config --
run --root "$P" --home "$H" --project "$BARE"
expect FD28-store-none-profile-none 0 "PASS  profile       none (project-profile.sh)" "SKIP  store-config  not a theme checkout (profile none)"
PRJ3="$TMP/project3"; mkdir -p "$PRJ3/layout"; : > "$PRJ3/layout/theme.liquid"; printf 'X=%s\n' "$SECRET" > "$PRJ3/.env"
run --root "$P" --home "$H" --project "$PRJ3"
expect FD29-store-toml-missing 0 "WARN  store-config  shopify.theme.toml absent in $PRJ3" "; .env present (values not read)" "!$SECRET"
PRJ4="$TMP/project4"; mkdir -p "$PRJ4/layout"; : > "$PRJ4/layout/theme.liquid"
run --root "$P" --home "$H" --project "$PRJ4"
expect FD30-store-theme-without-config 0 "WARN  store-config  shopify.theme.toml and .env absent in $PRJ4"

# ------------------------------------------------------------------------------- event-log --
jl() { printf '{"ts":"%s","plugin":"%s","version":"0.1.0","session":"s1","kind":"start","agent":"main","text":"x"}\n' "$2" "$1"; }
LD="$TMP/logs/s1"; mkdir -p "$LD"
{ jl fe 2026-10-08T09:00:00.000Z; jl fe 2026-10-08T09:05:00.000Z; } > "$LD/fe.jsonl"
jl base 2026-10-08T09:07:00.000Z > "$LD/base.jsonl"
run --root "$P" --home "$H" --project "$PRJ" --log-dir "$LD"
expect FD31-event-log-session 0 "PASS  event-log     $LD/fe.jsonl: 2 line(s), newest 2026-10-08T09:05:00.000Z" "!base.jsonl"
printf '{ cut mid-line\n' >> "$LD/fe.jsonl"
run --root "$P" --home "$H" --project "$PRJ" --log-dir "$LD"
expect FD32-event-log-unreadable-last 0 "fe.jsonl: 3 line(s), newest unreadable"
# A /clear's new id has no directory before its first line, and a session may have only others' files: not a failure.
run --root "$P" --home "$H" --project "$PRJ" --log-dir "$TMP/logs/gone"
expect FD33-event-log-no-dir-yet 0 "PASS  event-log     $TMP/logs/gone: no fe.jsonl line yet this session" "!warned"
mkdir -p "$TMP/logs/others"; jl band 2026-10-08T10:00:00.000Z > "$TMP/logs/others/band.jsonl"
run --root "$P" --home "$H" --project "$PRJ" --log-dir "$TMP/logs/others"
expect FD34-event-log-others-only 0 "PASS  event-log     $TMP/logs/others: no fe.jsonl line yet this session"
rc=0; FE_EVENT_LOG=0 PATH="$WITH_SHOP" "$NODE" "$DOCTOR" --root "$P" --home "$H" --project "$PRJ" --log-dir "$TMP/logs/others" >"$O" 2>"$E" || rc=$?
expect FD35-event-log-off 0 "PASS  event-log     $TMP/logs/others: fe's is off (FE_EVENT_LOG=0)"
# By hand (no --log-dir): the newest session directory under <home>/.claude/domaine/log, a link never followed.
HL="$TMP/h-logs"; mkhome "$HL" "$(installed "$BASE_USER")"; R="$HL/.claude/domaine/log"
mkdir -p "$R/old" "$R/new"; jl fe 2026-10-01T00:00:00.000Z > "$R/old/fe.jsonl"; jl fe 2026-10-08T00:00:00.000Z > "$R/new/fe.jsonl"
touch -t 202010010000 "$R/old/fe.jsonl" "$R/old"
mkdir -p "$TMP/elsewhere-log"; jl fe 2026-10-09T00:00:00.000Z > "$TMP/elsewhere-log/fe.jsonl"; ln -s "$TMP/elsewhere-log" "$R/zlink"
run --root "$P" --home "$HL" --project "$PRJ"
expect FD36-event-log-newest-by-hand 0 "PASS  event-log     $R/new/fe.jsonl: 1 line(s), newest 2026-10-08T00:00:00.000Z" "!elsewhere-log"
rc=0; DOMAINE_LOG_DIR="$TMP/logs" PATH="$WITH_SHOP" "$NODE" "$DOCTOR" --root "$P" --home "$HL" --project "$PRJ" >"$O" 2>"$E" || rc=$?
expect FD37-event-log-override 0 "PASS  event-log     $TMP/logs/" "!$R"
rc=0; DOMAINE_LOG_DIR=relative/logs PATH="$WITH_SHOP" "$NODE" "$DOCTOR" --root "$P" --home "$HL" --project "$PRJ" >"$O" 2>"$E" || rc=$?
expect FD38-event-log-relative-override-ignored 0 "PASS  event-log     $R/new/fe.jsonl"

# The suite never touched the real checkout.
if [ "$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo none)" = "$HEAD_BEFORE" ]; then ok; else bad FD-head "HEAD moved"; fi

echo "fe-doctor-sim: $pass passed, $fail failed"
if [ "$fail" -gt 0 ]; then printf '%s' "$failures"; exit 1; fi
