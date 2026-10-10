#!/usr/bin/env bash
# Simulation harness for plugins/qa/scripts/doctor.cjs: every case runs the doctor against a sandbox plugin
# root (--root), a sandbox home (--home) holding `.claude/` and `.config/domaine/`, a sandbox project
# (--project) and a PATH whose `gh` is a stub or absent. base is the repo's own plugins/base (its real
# manifest and `qa-stores.cjs`) or a planted copy, named through installed_plugins.json's installPath. No
# host, no network, nothing written outside $TMPDIR. The session rows (base loaded, slim's view tool) are the
# mod's and live in plugins/qa/hooks/mods/tests/doctor.test.ts. Exit 0 = all green.
set -u
unset CLAUDE_CONFIG_DIR DOMAINE_LOG_DIR QA_EVENT_LOG

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DOCTOR="$ROOT/plugins/qa/scripts/doctor.cjs"
REAL_BASE="$ROOT/plugins/base"
NODE="$(command -v node)"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
HEAD_BEFORE="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo none)"
O="$TMP/out"; E="$TMP/err"

pass=0; fail=0; failures=""
ok() { pass=$((pass + 1)); }
bad() { fail=$((fail + 1)); failures="${failures}  [$1] $2
"; }

# A PATH with a `gh` stub, one with a failing stub and one without: never the developer's own gh.
GHBIN="$TMP/ghbin"; mkdir -p "$GHBIN"
printf '#!/bin/sh\necho "gh version 2.61.0 (2026-01-01)"\n' > "$GHBIN/gh"; chmod 755 "$GHBIN/gh"
BADGH="$TMP/badgh"; mkdir -p "$BADGH"
printf '#!/bin/sh\necho "gh: broken install" >&2\nexit 4\n' > "$BADGH/gh"; chmod 755 "$BADGH/gh"
WITH_GH="$GHBIN:/usr/bin:/bin"
# An empty directory, not /usr/bin: a CI runner keeps gh there.
NO_GH="$TMP/nogh"; mkdir -p "$NO_GH"

rc=0
# run [--path <PATH>] <doctor args...> — PATH defaults to the one with the stub.
run() {
  local p="$WITH_GH"
  if [ "${1:-}" = --path ]; then p="$2"; shift 2; fi
  rc=0; PATH="$p" "$NODE" "$DOCTOR" "$@" >"$O" 2>"$E" || rc=$?
}
WIN_SHIM="$TMP/as-win32.cjs"
printf "Object.defineProperty(process, 'platform', { value: 'win32' });\n" > "$WIN_SHIM"
runwin() { rc=0; PATH="$WITH_GH" "$NODE" --require "$WIN_SHIM" "$DOCTOR" "$@" >"$O" 2>"$E" || rc=$?; }

# expect <label> <want-rc> [pattern ...] — every pattern must appear in stdout as a literal;
# a pattern prefixed with ! must NOT appear.
expect() {
  local label="$1" want="$2" p; shift 2
  if [ "$rc" -ne "$want" ]; then
    bad "$label" "exit $rc, want $want :: $(tr '\n' ';' <"$O" | head -c 600) err=$(head -c 160 "$E")"; return
  fi
  for p in "$@"; do
    if [ "${p#!}" != "$p" ]; then
      if grep -qF -- "${p#!}" "$O"; then bad "$label" "stdout has forbidden '${p#!}' :: $(tr '\n' ';' <"$O" | head -c 600)"; return; fi
    elif ! grep -qF -- "$p" "$O"; then
      bad "$label" "stdout missing '$p' :: $(tr '\n' ';' <"$O" | head -c 600)"; return
    fi
  done
  ok
}

# mkplugin <dir> — a plugin root that passes the manifest and scripts rows: an executable .sh, a sourced
# _*.sh without its exec bit, a .cjs that parses.
mkplugin() {
  local d="$1"
  mkdir -p "$d/.claude-plugin" "$d/scripts"
  printf '{"name":"qa","version":"0.9.1","dependencies":["base"]}\n' > "$d/.claude-plugin/plugin.json"
  printf '#!/bin/sh\nexit 0\n' > "$d/scripts/fetch.sh"; chmod 755 "$d/scripts/fetch.sh"
  printf 'trim_ws() { :; }\n' > "$d/scripts/_common.sh"; chmod 644 "$d/scripts/_common.sh"
  printf '#!/usr/bin/env node\nconsole.log(1);\n' > "$d/scripts/tool.cjs"; chmod 755 "$d/scripts/tool.cjs"
}

# mkbase <dir> [manifest-json] — a planted base install: the manifest given (default: one declaring the
# browser server) and a copy of base's real registry script.
BASE_MANIFEST='{"name":"base","version":"0.3.1","mcpServers":{"chrome-devtools-mcp":{}}}'
mkbase() {
  local d="$1" m="${2:-$BASE_MANIFEST}"
  mkdir -p "$d/.claude-plugin" "$d/scripts"
  printf '%s\n' "$m" > "$d/.claude-plugin/plugin.json"
  cp "$REAL_BASE/scripts/qa-stores.cjs" "$d/scripts/qa-stores.cjs"
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

base_user() { printf '"base@domaine":[{"scope":"user","version":"%s","installPath":"%s"}]' "${2:-0.3.1}" "$1"; }
installed() { printf '{"version":2,"plugins":{%s}}' "$1"; }
SECRET="fixture-storefront-pw-never-printed"

# register <home> — one store in <home>'s registry through base's real script, with a password.
register() {
  HOME="$1" "$NODE" "$REAL_BASE/scripts/qa-stores.cjs" set acme-us-uat.myshopify.com --alias 'ACME US UAT' \
    --theme 123456789012:develop --default-theme 123456789012 --password "$SECRET" >/dev/null 2>&1
}

P="$TMP/plugin"; mkplugin "$P"
H="$TMP/home"; mkhome "$H" "$(installed "$(base_user "$REAL_BASE")")"; register "$H"
PRJ="$TMP/project"; mkdir -p "$PRJ"
REG="$H/.config/domaine/qa-stores.json"
[ -f "$REG" ] && grep -qF "$SECRET" "$REG" && ok || bad FD0-fixture "the sandbox registry was not written by qa-stores.cjs set"

# ----------------------------------------------------------------------------------- green --
run --root "$P" --home "$H" --project "$PRJ"
expect FD1-green 0 "qa doctor — plugin root: $P" "PASS  node" "PASS  manifest         qa 0.9.1, depends on base" \
  "PASS  scripts          3 script(s): every .sh executable, every .cjs parses" \
  "PASS  base             base@domaine 0.3.1 installed and enabled" \
  "PASS  registry         $REG: 1 store(s) registered" "PASS  gh               gh 2.61.0" \
  "PASS  chrome-devtools  base 0.3.1 declares chrome-devtools-mcp" \
  "PASS  event-log        $H/.claude/domaine/log: no session directory yet" "doctor: 8 passed, 0 failed, 0 skipped" \
  "!$SECRET" "!acme-us-uat" "!ACME US UAT"

# The shipped plugin passes its own manifest and scripts rows.
run --home "$H" --project "$PRJ"
expect FD2-shipped-plugin 0 "plugin root: $ROOT/plugins/qa" "PASS  manifest         qa " "PASS  scripts          " "!FAIL" "!$SECRET"

run --root "$P" --home "$H" --project "$PRJ" --json
if "$NODE" -e '
  const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const names = j.rows.map((r) => r.name).join(",");
  if (j.root !== process.argv[2] || names !== "node,manifest,scripts,base,registry,gh,chrome-devtools,event-log") process.exit(1);
  if (!j.rows.every((r) => ["PASS","FAIL","SKIP","WARN"].includes(r.status) && typeof r.detail === "string")) process.exit(1);
' "$O" "$P" 2>/dev/null && [ "$rc" -eq 0 ] && [ "$(wc -l < "$O" | tr -d ' ')" = "1" ] && ! grep -qF "$SECRET" "$O"; then ok
else bad FD3-json "rc=$rc out=$(head -c 300 "$O")"; fi

# ----------------------------------------------------------------------------------- usage --
run --help; expect FD4-help 0 "usage: doctor.cjs"
run --bogus; if [ "$rc" -eq 2 ] && grep -q 'unknown argument --bogus' "$E"; then ok; else bad FD5-unknown-arg "rc=$rc err=$(head -c 200 "$E")"; fi
run --root; if [ "$rc" -eq 2 ] && grep -q -- '--root needs a value' "$E"; then ok; else bad FD5b-missing-value "rc=$rc"; fi

# -------------------------------------------------------------------------------- manifest --
M="$TMP/m1"; mkplugin "$M"; rm "$M/.claude-plugin/plugin.json"
run --root "$M" --home "$H" --project "$PRJ"; expect FD6-manifest-missing 1 "FAIL  manifest         .claude-plugin/plugin.json missing — this is not a plugin root"
printf '{ not json' > "$M/.claude-plugin/plugin.json"
run --root "$M" --home "$H" --project "$PRJ"; expect FD7-manifest-invalid 1 "FAIL  manifest         .claude-plugin/plugin.json invalid JSON"
printf '{"name":"qa"}' > "$M/.claude-plugin/plugin.json"
run --root "$M" --home "$H" --project "$PRJ"; expect FD8-manifest-no-version 1 'has no "version" string'
printf '{"name":"quality","version":"1.0.0","dependencies":["base"]}' > "$M/.claude-plugin/plugin.json"
run --root "$M" --home "$H" --project "$PRJ"; expect FD9-manifest-name 1 'name "quality" is not "qa"'
printf '{"name":"qa","version":"1.0.0","dependencies":["slim"]}' > "$M/.claude-plugin/plugin.json"
run --root "$M" --home "$H" --project "$PRJ"; expect FD10-manifest-no-base-dep 1 'version 1.0.0 does not declare base in "dependencies"'

# --------------------------------------------------------------------------------- scripts --
S="$TMP/s1"; mkplugin "$S"; chmod 644 "$S/scripts/fetch.sh"
run --root "$S" --home "$H" --project "$PRJ"
expect FD11-sh-not-exec 1 "FAIL  scripts          fetch.sh not executable — chmod +x" "!_common.sh"
H8="$TMP/h-nopath"; mkhome "$H8" '{"version":2,"plugins":{"base@domaine":[{"scope":"user","version":"0.3.1"}]}}'
runwin --root "$S" --home "$H8" --project "$PRJ"
expect FD12-windows-no-exec-bits 0 "PASS  scripts          3 script(s)"
S2="$TMP/s2"; mkplugin "$S2"; printf 'module.exports = { broken: ;\n' > "$S2/scripts/broken.cjs"
run --root "$S2" --home "$H" --project "$PRJ"
expect FD13-cjs-no-parse 1 "FAIL  scripts          broken.cjs does not parse: SyntaxError" "!tool.cjs"
S3="$TMP/s3"; mkplugin "$S3"; ln -s "$TMP/nowhere.sh" "$S3/scripts/gone.sh"
run --root "$S3" --home "$H" --project "$PRJ"
expect FD14-dangling-link 1 "FAIL  scripts          gone.sh missing (a dangling link?)"
S4="$TMP/s4"; mkdir -p "$S4/.claude-plugin" "$S4/scripts"; cp "$P/.claude-plugin/plugin.json" "$S4/.claude-plugin/"
run --root "$S4" --home "$H" --project "$PRJ"
expect FD15-no-scripts 1 "FAIL  scripts          scripts/ holds no script"
rmdir "$S4/scripts"
run --root "$S4" --home "$H" --project "$PRJ"
expect FD16-no-scripts-dir 1 "FAIL  scripts          scripts/ unreadable"

# ------------------------------------------------------------------------------------ base --
H2="$TMP/h-nobase"; mkhome "$H2" "$(installed '')"
run --root "$P" --home "$H2" --project "$PRJ"
expect FD17-base-absent 1 "FAIL  base             not installed" "claude plugin install base@domaine" \
  "SKIP  registry         base is not installed and enabled" "SKIP  chrome-devtools  base's install directory is unknown"
H3="$TMP/h-noinstalled"; mkhome "$H3"
run --root "$P" --home "$H3" --project "$PRJ"; expect FD18-no-install-record 1 "FAIL  base             not installed"
H4="$TMP/h-baseoff"; mkhome "$H4" "$(installed "$(base_user "$REAL_BASE")")" '{"enabledPlugins":{"base@domaine":false}}'
run --root "$P" --home "$H4" --project "$PRJ"
expect FD19-base-disabled-user 1 "FAIL  base             base@domaine 0.3.1 is installed but disabled — enable it in /plugin" "SKIP  registry"
H4b="$TMP/h-basenokey"; mkhome "$H4b" "$(installed "$(base_user "$REAL_BASE")")" '{}'
run --root "$P" --home "$H4b" --project "$PRJ"
expect FD19b-base-no-key 1 "FAIL  base             base@domaine 0.3.1 is installed but disabled — enable it in /plugin" "SKIP  registry"
PRJ2="$TMP/project2"; mkdir -p "$PRJ2/.claude"; printf '{"enabledPlugins":{"base@domaine":false}}\n' > "$PRJ2/.claude/settings.local.json"
run --root "$P" --home "$H" --project "$PRJ2"; expect FD20-base-disabled-project-local 1 "is installed but disabled"
BASE_PROJ="\"base@domaine\":[{\"scope\":\"project\",\"projectPath\":\"$PRJ\",\"version\":\"0.3.2\",\"installPath\":\"$REAL_BASE\"}]"
H5="$TMP/h-baseproj"; mkhome "$H5" "$(installed "$BASE_PROJ")"
run --root "$P" --home "$H5" --project "$PRJ"; expect FD21-base-this-project 0 "PASS  base             base@domaine 0.3.2 installed and enabled"
run --root "$P" --home "$H5" --project "$PRJ2"; expect FD22-base-other-project 1 "FAIL  base             not installed"
# CLAUDE_CONFIG_DIR stands in for ~/.claude without --home, and --home overrides it.
# HOME points away from both, so the run reads nothing of the developer's own home.
rc=0; HOME="$TMP/elsewhere-home" CLAUDE_CONFIG_DIR="$H/.claude" PATH="$WITH_GH" "$NODE" "$DOCTOR" --root "$P" --project "$PRJ" >"$O" 2>"$E" || rc=$?
expect FD23-claude-config-dir 0 "PASS  base             base@domaine 0.3.1 installed and enabled" "SKIP  registry         no registry yet"
rc=0; CLAUDE_CONFIG_DIR="$H2/.claude" PATH="$WITH_GH" "$NODE" "$DOCTOR" --root "$P" --home "$H" --project "$PRJ" >"$O" 2>"$E" || rc=$?
expect FD24-home-beats-config-dir 0 "PASS  base             base@domaine 0.3.1"

# -------------------------------------------------------------------------------- registry --
H6="$TMP/h-noreg"; mkhome "$H6" "$(installed "$(base_user "$REAL_BASE")")"
run --root "$P" --home "$H6" --project "$PRJ"
expect FD25-registry-none-yet 0 "SKIP  registry         no registry yet: qa-stores.cjs set <domain> --alias <a> --password <p> ($H6/.config/domaine/qa-stores.json)"
H7="$TMP/h-corrupt"; mkhome "$H7" "$(installed "$(base_user "$REAL_BASE")")"; mkdir -p "$H7/.config/domaine"
printf '{"version":1,"stores":{"x.myshopify.com":{"password":"%s" BROKEN' "$SECRET" > "$H7/.config/domaine/qa-stores.json"
run --root "$P" --home "$H7" --project "$PRJ"
expect FD26-registry-corrupt-no-secret 1 "FAIL  registry         $H7/.config/domaine/qa-stores.json is unreadable or corrupt — run qa-stores.cjs list to see why" "!$SECRET" "!BROKEN" "!not valid JSON" "!qa-stores:"
# A registry whose error text quotes the file: neither the corrupt branch (exit 3) nor any other failing
# exit relays the script's stderr.
for code in 3 4; do
  LEAKB="$TMP/leakbase$code"; mkbase "$LEAKB"
  printf '#!/usr/bin/env node\nif (process.argv[2] === "path") { console.log(process.env.HOME + "/.config/domaine/qa-stores.json"); } else { process.stderr.write("qa-stores: quoted %s\\n"); process.exit(%s); }\n' "$SECRET" "$code" > "$LEAKB/scripts/qa-stores.cjs"
  HLK="$TMP/h-leak$code"; mkhome "$HLK" "$(installed "$(base_user "$LEAKB")")"; mkdir -p "$HLK/.config/domaine"; : > "$HLK/.config/domaine/qa-stores.json"
  run --root "$P" --home "$HLK" --project "$PRJ"
  expect "FD26b-registry-stderr-not-relayed-exit$code" 1 "FAIL  registry         " "!$SECRET" "!quoted"
done
run --root "$P" --home "$H8" --project "$PRJ"
expect FD27-registry-no-installpath 0 "SKIP  registry         base@domaine has no installPath in installed_plugins.json" "SKIP  chrome-devtools"
OLDB="$TMP/oldbase"; mkbase "$OLDB"; rm "$OLDB/scripts/qa-stores.cjs"
H9="$TMP/h-oldbase"; mkhome "$H9" "$(installed "$(base_user "$OLDB" 0.1.0)")"
run --root "$P" --home "$H9" --project "$PRJ"
expect FD28-registry-script-missing 1 "FAIL  registry         $OLDB/scripts/qa-stores.cjs missing — base 0.1.0 has no QA store registry; update base"
STUBB="$TMP/stubbase"; mkbase "$STUBB"; printf '#!/usr/bin/env node\nprocess.stderr.write("boom\\n"); process.exit(5);\n' > "$STUBB/scripts/qa-stores.cjs"
H10="$TMP/h-stubbase"; mkhome "$H10" "$(installed "$(base_user "$STUBB")")"
run --root "$P" --home "$H10" --project "$PRJ"
expect FD29-registry-path-fails 1 "FAIL  registry         qa-stores.cjs path exited 5"
LISTB="$TMP/listbase"; mkbase "$LISTB"
printf '#!/usr/bin/env node\nif (process.argv[2] === "path") { console.log(process.env.HOME + "/.config/domaine/qa-stores.json"); } else { console.log("not json"); }\n' > "$LISTB/scripts/qa-stores.cjs"
H11="$TMP/h-listbase"; mkhome "$H11" "$(installed "$(base_user "$LISTB")")"; mkdir -p "$H11/.config/domaine"; : > "$H11/.config/domaine/qa-stores.json"
run --root "$P" --home "$H11" --project "$PRJ"
expect FD30-registry-list-not-a-list 1 "FAIL  registry         qa-stores.cjs list --json exited 0 without a store list"

# -------------------------------------------------------------------------------------- gh --
run --path "$NO_GH" --root "$P" --home "$H" --project "$PRJ"
expect FD31-gh-absent 0 "WARN  gh               gh is not on PATH — PR facts fall back to the ticket's links" ", 1 warned"
run --path "$BADGH:/usr/bin:/bin" --root "$P" --home "$H" --project "$PRJ"
expect FD32-gh-failing 0 "WARN  gh               gh --version exited 4: gh: broken install"

# ------------------------------------------------------------------------- chrome-devtools --
NOB="$TMP/nobrowser"; mkbase "$NOB" '{"name":"base","version":"0.3.1","mcpServers":{"atlassian":{}}}'
H12="$TMP/h-nobrowser"; mkhome "$H12" "$(installed "$(base_user "$NOB")")"
run --root "$P" --home "$H12" --project "$PRJ"
expect FD33-browser-server-missing 1 "FAIL  chrome-devtools  base 0.3.1 declares no chrome-devtools-mcp server"
BADM="$TMP/badmanifest"; mkbase "$BADM" '{ not json'
H13="$TMP/h-badmanifest"; mkhome "$H13" "$(installed "$(base_user "$BADM")")"
run --root "$P" --home "$H13" --project "$PRJ"
expect FD34-base-manifest-unreadable 1 "FAIL  chrome-devtools  $BADM/.claude-plugin/plugin.json unreadable or not a JSON object"

# ------------------------------------------------------------------------------- event-log --
jl() { printf '{"ts":"%s","plugin":"%s","version":"0.1.0","session":"s1","kind":"start","agent":"main","text":"x"}\n' "$2" "$1"; }
LD="$TMP/logs/s1"; mkdir -p "$LD"
{ jl qa 2026-10-08T09:00:00.000Z; jl qa 2026-10-08T09:05:00.000Z; } > "$LD/qa.jsonl"
jl base 2026-10-08T09:07:00.000Z > "$LD/base.jsonl"
run --root "$P" --home "$H" --project "$PRJ" --log-dir "$LD"
expect FD35-event-log-session 0 "PASS  event-log        $LD/qa.jsonl: 2 line(s), newest 2026-10-08T09:05:00.000Z" "!base.jsonl"
printf '{ cut mid-line\n' >> "$LD/qa.jsonl"
run --root "$P" --home "$H" --project "$PRJ" --log-dir "$LD"
expect FD36-event-log-unreadable-last 0 "qa.jsonl: 3 line(s), newest unreadable"
run --root "$P" --home "$H" --project "$PRJ" --log-dir "$TMP/logs/gone"
expect FD37-event-log-no-dir-yet 0 "PASS  event-log        $TMP/logs/gone: no qa.jsonl line yet this session" "!warned"
mkdir -p "$TMP/logs/others"; jl band 2026-10-08T10:00:00.000Z > "$TMP/logs/others/band.jsonl"
run --root "$P" --home "$H" --project "$PRJ" --log-dir "$TMP/logs/others"
expect FD38-event-log-others-only 0 "PASS  event-log        $TMP/logs/others: no qa.jsonl line yet this session"
rc=0; QA_EVENT_LOG=0 PATH="$WITH_GH" "$NODE" "$DOCTOR" --root "$P" --home "$H" --project "$PRJ" --log-dir "$TMP/logs/others" >"$O" 2>"$E" || rc=$?
expect FD39-event-log-off 0 "PASS  event-log        $TMP/logs/others: qa's is off (QA_EVENT_LOG=0)"
mkdir -p "$TMP/logs2/dirfile/qa.jsonl"
run --root "$P" --home "$H" --project "$PRJ" --log-dir "$TMP/logs2/dirfile"
expect FD40-event-log-unreadable 0 "WARN  event-log        $TMP/logs2/dirfile/qa.jsonl unreadable"
# By hand (no --log-dir): the newest session directory under <home>/.claude/domaine/log, a link never followed.
HL="$TMP/h-logs"; mkhome "$HL" "$(installed "$(base_user "$REAL_BASE")")"; R="$HL/.claude/domaine/log"
mkdir -p "$R/a-old" "$R/b-new"; jl qa 2026-10-01T00:00:00.000Z > "$R/a-old/qa.jsonl"; jl qa 2026-10-08T00:00:00.000Z > "$R/b-new/qa.jsonl"
touch -t 202010010000 "$R/a-old/qa.jsonl" "$R/a-old"
mkdir -p "$TMP/elsewhere-log"; jl qa 2026-10-09T00:00:00.000Z > "$TMP/elsewhere-log/qa.jsonl"; ln -s "$TMP/elsewhere-log" "$R/zlink"
run --root "$P" --home "$HL" --project "$PRJ"
expect FD41-event-log-newest-by-hand 0 "PASS  event-log        $R/b-new/qa.jsonl: 1 line(s), newest 2026-10-08T00:00:00.000Z" "!elsewhere-log"
rc=0; DOMAINE_LOG_DIR="$TMP/logs" PATH="$WITH_GH" "$NODE" "$DOCTOR" --root "$P" --home "$HL" --project "$PRJ" >"$O" 2>"$E" || rc=$?
expect FD42-event-log-override 0 "PASS  event-log        $TMP/logs/" "!$R"
rc=0; DOMAINE_LOG_DIR=relative/logs PATH="$WITH_GH" "$NODE" "$DOCTOR" --root "$P" --home "$HL" --project "$PRJ" >"$O" 2>"$E" || rc=$?
expect FD43-event-log-relative-override-ignored 0 "PASS  event-log        $R/b-new/qa.jsonl"

# The suite never touched the real checkout, and the sandbox registry still holds its password unprinted.
if [ "$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo none)" = "$HEAD_BEFORE" ]; then ok; else bad FD-head "HEAD moved"; fi
if grep -qF "$SECRET" "$REG"; then ok; else bad FD-registry-kept "the doctor changed the sandbox registry"; fi

echo "qa-doctor-sim: $pass passed, $fail failed"
if [ "$fail" -gt 0 ]; then printf '%s' "$failures"; exit 1; fi
