#!/usr/bin/env bash
# Simulation harness for the bundled shell/node scripts (2026-07 audit, batch C).
# No network, no store: theme-json runs against a stub runner; shopify-admin-gql runs
# against PATH shims of `shopify` and `curl`. Exit 0 = all green.
set -u

# Hermetic env: a developer who exports FND_MCP_SLIM_DEBUG=1 / FND_MCP_SLIM_DIR to watch the log live
# would otherwise have json-slim drop a debug log into each case's spill directory, which the
# before/after directory diffs below read as an unexpected spill. Every case that needs either switch
# sets it explicitly on the invocation.
unset FND_MCP_SLIM_DEBUG FND_MCP_SLIM_DIR

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GQL="$ROOT/plugins/fnd/scripts/shopify-admin-gql.sh"
TJ="$ROOT/plugins/fnd/scripts/theme-json.sh"
CPT="$ROOT/plugins/fnd/scripts/create-preview-theme.sh"
FBC="$ROOT/plugins/fnd/skills/fix-breaking-changes/scripts/fix-breaking-changes.template.js"
BASH_BIN="$(command -v bash)"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pass=0; fail=0; failures=""
ok() { pass=$((pass + 1)); }
bad() { fail=$((fail + 1)); failures="${failures}  [$1] $2
"; }
# assert <label> <want-rc> <got-rc> <stderr-file> [required-stderr-substring]
assert() {
  local label="$1" want="$2" got="$3" errf="$4" substr="${5-}"
  if [ "$got" -ne "$want" ]; then
    bad "$label" "exit $got, want $want :: $(head -c 200 "$errf" | tr '\n' ' ')"; return
  fi
  if [ -n "$substr" ] && ! grep -q "$substr" "$errf"; then
    bad "$label" "stderr missing '$substr' :: $(head -c 200 "$errf" | tr '\n' ' ')"; return
  fi
  ok
}

# ---------------------------------------------- theme-json.sh against a stub runner --
TJDIR="$TMP/tj"; mkdir -p "$TJDIR"
cp "$TJ" "$TJDIR/theme-json.sh"
cat > "$TJDIR/shopify-admin-gql.sh" <<'STUB'
#!/usr/bin/env bash
# stub runner — answers by query content; FAKE_ROLE controls the theme role,
# FAKE_RUNNER_MODE simulates the runner's exit-3 stderr contracts
set -u
case "${FAKE_RUNNER_MODE:-ok}" in
  mutfail) echo "error=store_execute_failed_mutation (stub)" >&2; exit 3 ;;
  nocreds) echo "error=no_admin_token" >&2; exit 3 ;;
  errenv)  big=$(printf 'p%.0s' $(seq 1 9000))
           printf '{"errors":[{"message":"boom"}],"data":{"theme":{"pad":"%s"}}}\n' "$big"; exit 0 ;;
  notjson) echo "<<<not json>>>"; exit 0 ;;
esac
Q=""
while [ $# -gt 0 ]; do case "$1" in --query) Q="$2"; shift 2 ;; *) shift ;; esac; done
role="${FAKE_ROLE:-DEVELOPMENT}"
if grep -q FndThemesList "$Q"; then
  printf '{"data":{"themes":{"nodes":[{"id":"gid://shopify/OnlineStoreTheme/1","name":"Live","role":"MAIN"},{"id":"gid://shopify/OnlineStoreTheme/2","name":"Dev","role":"DEVELOPMENT"}]}}}\n'
elif grep -q FndThemeFileGet "$Q"; then
  if [ -n "${FAKE_BIG:-}" ]; then
    big=$(printf 'x%.0s' $(seq 1 9000))
    printf '{"data":{"theme":{"id":"gid://shopify/OnlineStoreTheme/2","name":"Dev","role":"%s","files":{"nodes":[{"filename":"templates/product.json","updatedAt":"now","body":{"content":"%s"}}],"userErrors":[]}}}}\n' "$role" "$big"
  else
    printf '{"data":{"theme":{"id":"gid://shopify/OnlineStoreTheme/2","name":"Dev","role":"%s","files":{"nodes":[{"filename":"templates/product.json","updatedAt":"now","body":{"content":"{\\"a\\":1}"}}],"userErrors":[]}}}}\n' "$role"
  fi
elif grep -q FndThemeMeta "$Q"; then
  printf '{"data":{"theme":{"id":"gid://shopify/OnlineStoreTheme/2","name":"Dev","role":"%s"}}}\n' "$role"
elif grep -q FndThemeFileSet "$Q"; then
  if [ -n "${FAKE_UE:-}" ]; then
    printf '{"data":{"themeFilesUpsert":{"upsertedThemeFiles":[],"userErrors":[{"field":["files"],"message":"nope","code":"ERROR"}]}}}\n'
  else
    printf '{"data":{"themeFilesUpsert":{"upsertedThemeFiles":[{"filename":"templates/product.json"}],"userErrors":[]}}}\n'
  fi
else
  echo "error=stub_unknown_query" >&2; exit 5
fi
STUB
chmod +x "$TJDIR/theme-json.sh" "$TJDIR/shopify-admin-gql.sh"

E="$TMP/err"; O="$TMP/out"

# T1 (bug): a failed --out write is a hard stop, not ok=saved
rc=0; "$BASH_BIN" "$TJDIR/theme-json.sh" get --theme 2 --file templates/product.json \
  --out "$TMP/no/such/dir/x.json" >"$O" 2>"$E" || rc=$?
assert T1-out-write-failed 5 "$rc" "$E" "error=out_write_failed"

# T2: a good --out still works and lands the exact body
rc=0; "$BASH_BIN" "$TJDIR/theme-json.sh" get --theme 2 --file templates/product.json \
  --out "$TMP/snap.json" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ "$(cat "$TMP/snap.json")" = '{"a":1}' ]; then ok; else bad T2-out-ok "rc=$rc body=$(cat "$TMP/snap.json" 2>/dev/null)"; fi

# T3 (bug): an invalid --role is a usage error, not a silent empty list
rc=0; "$BASH_BIN" "$TJDIR/theme-json.sh" themes --role dev >"$O" 2>"$E" || rc=$?
assert T3-invalid-role 2 "$rc" "$E" "error=invalid_role"

# T4: a valid --role filters
rc=0; "$BASH_BIN" "$TJDIR/theme-json.sh" themes --role development >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ "$(grep -c Dev "$O")" = 1 ] && ! grep -q Live "$O"; then ok; else bad T4-role-filter "rc=$rc out=$(cat "$O")"; fi

# T5: live-theme write still refused (regression)
rc=0; FAKE_ROLE=MAIN "$BASH_BIN" "$TJDIR/theme-json.sh" set --theme 2 --file templates/product.json \
  --from "$TMP/snap.json" >"$O" 2>"$E" || rc=$?
assert T5-live-refused 4 "$rc" "$E" "live_theme_write_refused"

# T6: dev-theme write goes through the stub (regression)
rc=0; "$BASH_BIN" "$TJDIR/theme-json.sh" set --theme 2 --file templates/product.json \
  --from "$TMP/snap.json" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -q '"ok":"upserted"' "$O"; then ok; else bad T6-set-ok "rc=$rc out=$(cat "$O")"; fi

# T7 (bug): themes list no longer truncates at 50
if grep -q 'first: 250' "$TJDIR/theme-json.sh"; then ok; else bad T7-first-250 "themes query still first: 50"; fi

# T8 (pin): --role live maps to the GraphQL enum MAIN at dispatch (theme-json.sh:328) —
# subtle enough that a review already misread it as broken once
rc=0; "$BASH_BIN" "$TJDIR/theme-json.sh" themes --role live >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -q Live "$O" && ! grep -q Dev "$O"; then ok; else bad T8-role-live "rc=$rc out=$(cat "$O")"; fi

# themecli shim for the auto-fallback cases — records every invocation
TJSHIM="$TMP/tjshim"; mkdir -p "$TJSHIM"
cat > "$TJSHIM/shopify" <<'FAKE'
#!/usr/bin/env bash
touch "${TJ_CLI_MARKER:-/dev/null}"
case "$*" in
  *"theme list"*) printf '[{"id":2,"name":"Dev","role":"development"}]\n' ;;
  *"theme push"*) printf '{}\n' ;;
esac
exit 0
FAKE
chmod +x "$TJSHIM/shopify"

# T9 (bug): runner exit 3 for an ATTEMPTED mutation must NOT fall back to themecli
# (a re-push could double-apply); the runner's stderr propagates instead
rc=0; M9="$TMP/tj9"; TJ_CLI_MARKER="$M9" FAKE_RUNNER_MODE=mutfail SHOPIFY_CLI_THEME_TOKEN=fake \
  PATH="$TJSHIM:$PATH" "$BASH_BIN" "$TJDIR/theme-json.sh" set --theme 2 --file templates/product.json \
  --from "$TMP/snap.json" --store test.myshopify.com >"$O" 2>"$E" || rc=$?
assert T9-mutfail-no-cli-fallback 3 "$rc" "$E" "store_execute_failed_mutation"
if [ ! -f "$M9" ]; then ok; else bad T9b-cli-untouched "themecli invoked after an attempted mutation"; fi

# T10: runner exit 3 for MISSING credentials still falls back to themecli
rc=0; M10="$TMP/tj10"; TJ_CLI_MARKER="$M10" FAKE_RUNNER_MODE=nocreds SHOPIFY_CLI_THEME_TOKEN=fake \
  PATH="$TJSHIM:$PATH" "$BASH_BIN" "$TJDIR/theme-json.sh" set --theme 2 --file templates/product.json \
  --from "$TMP/snap.json" --store test.myshopify.com >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ -f "$M10" ] && grep -q themecli "$O"; then ok; else bad T10-nocreds-fallback "rc=$rc out=$(cat "$O") err=$(head -c 150 "$E" | tr '\n' ' ')"; fi

# T11 (2026-07 token audit): a small inline get still prints the body verbatim
rc=0; "$BASH_BIN" "$TJDIR/theme-json.sh" get --theme 2 --file templates/product.json >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ "$(head -1 "$O")" = '{"a":1}' ]; then ok; else bad T11-small-inline "rc=$rc out=$(head -c 100 "$O")"; fi

# T12: an inline body over 8 KB is suppressed when CAPTURED (command substitution = pipe)
rc=0; outv="$(FAKE_BIG=1 "$BASH_BIN" "$TJDIR/theme-json.sh" get --theme 2 --file templates/product.json 2>"$E")" || rc=$?
if [ "$rc" -eq 0 ] && printf '%s' "$outv" | grep -q 'note=large_file' \
   && ! printf '%s' "$outv" | grep -q 'xxxxxxxx'; then ok
else bad T12-large-suppressed "rc=$rc out=$(printf '%s' "$outv" | head -c 120)"; fi

# T12b: an improvised `get > snap.json` of a large file is FAIL-CLOSED — the captured
# note is self-describing and not valid JSON, so a later `set --from` refuses it before
# any upload (real snapshots use --out)
rc=0; FAKE_BIG=1 "$BASH_BIN" "$TJDIR/theme-json.sh" get --theme 2 --file templates/product.json >"$TMP/redir.json" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -q 'NOT the file content' "$TMP/redir.json" \
   && ! jq empty "$TMP/redir.json" >/dev/null 2>&1; then ok
else bad T12b-redirect-failclosed "rc=$rc head=$(head -c 100 "$TMP/redir.json" 2>/dev/null)"; fi
rc=0; "$BASH_BIN" "$TJDIR/theme-json.sh" set --theme 2 --file templates/product.json \
  --from "$TMP/redir.json" >"$O" 2>"$E" || rc=$?
assert T12c-note-restore-refused 2 "$rc" "$E" "error=from_file_invalid_json"

# T13: the same large body with --out saves the full bytes (no suppression on that path)
rc=0; FAKE_BIG=1 "$BASH_BIN" "$TJDIR/theme-json.sh" get --theme 2 --file templates/product.json \
  --out "$TMP/big.json" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ "$(wc -c < "$TMP/big.json" | tr -d ' ')" -ge 9000 ]; then ok; else bad T13-large-out "rc=$rc bytes=$(wc -c < "$TMP/big.json" 2>/dev/null)"; fi

# T14: a GraphQL error envelope prints the errors head only — partial data stays at log=
rc=0; FAKE_RUNNER_MODE=errenv "$BASH_BIN" "$TJDIR/theme-json.sh" themes >"$O" 2>"$E" || rc=$?
assert T14-errenv-exit 5 "$rc" "$E" "error=gql_errors"
if grep -q '"errors"' "$O" && ! grep -q 'pppppppp' "$O"; then ok; else bad T14b-data-stripped "out=$(head -c 150 "$O")"; fi
lf="$(grep -o 'log=/[^ ]*' "$E" | head -1 | cut -d= -f2)"
if [ -n "$lf" ] && grep -q 'pppppppp' "$lf"; then ok; else bad T14c-log-full "log=$lf missing the full envelope"; fi

# T15: upsert userErrors — the parsed errors + log= replace the full envelope on stdout
rc=0; FAKE_UE=1 "$BASH_BIN" "$TJDIR/theme-json.sh" set --theme 2 --file templates/product.json \
  --from "$TMP/snap.json" >"$O" 2>"$E" || rc=$?
assert T15-ue-exit 5 "$rc" "$E" "error=upsert_user_errors"
if [ ! -s "$O" ] && grep -q 'log=' "$E"; then ok; else bad T15b-stdout-clean "out=$(head -c 120 "$O")"; fi

# T16: a non-JSON runner response is truncated to a 600-byte head + log=
rc=0; FAKE_RUNNER_MODE=notjson "$BASH_BIN" "$TJDIR/theme-json.sh" themes >"$O" 2>"$E" || rc=$?
assert T16-notjson-exit 5 "$rc" "$E" "error=non_json_response"
if grep -q 'log=' "$E" && [ ! -s "$O" ]; then ok; else bad T16b-log-and-clean-stdout "out=$(head -c 100 "$O")"; fi

# ------------------------------------- shopify-admin-gql.sh against PATH shims --
SHIM="$TMP/shim"; mkdir -p "$SHIM"
GQLDIR="$TMP/gqlwork"; mkdir -p "$GQLDIR"
printf 'mutation FndX { thingCreate { id } }\n' > "$GQLDIR/mutation.graphql"
printf 'query FndY { shop { name } }\n' > "$GQLDIR/query.graphql"
printf '{"k":"v"}\n' > "$GQLDIR/vars.json"

cat > "$SHIM/shopify" <<'FAKE'
#!/usr/bin/env bash
if [ "${1:-}" = "version" ]; then echo "4.5.2"; exit 0; fi
case "${FAKE_EXEC_MODE:-garbage}" in
  garbage) echo "unexpected CLI crash output" >&2; exit 1 ;;
  noauth)  echo "No stored app authentication found" >&2; exit 1 ;;
  ok)      echo '{"ok":true}'; exit 0 ;;
esac
FAKE
cat > "$SHIM/curl" <<'FAKE'
#!/usr/bin/env bash
# emulates the exact flags the runner uses: -o <file>, -w '%{http_code}', --data @file
touch "${CURL_MARKER:-/dev/null}"
out=""; data=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -w) shift 2 ;;
    --data) data="$2"; shift 2 ;;
    -K|-H|-X) shift 2 ;;
    *) shift ;;
  esac
done
case "$data" in @*) cp "${data#@}" "${CURL_MARKER:-/dev/null}.body" 2>/dev/null || true ;; esac
body="${FAKE_HTTP_BODY:-}"; [ -n "$body" ] || body='{"data":{"ok":true}}'
printf '%s' "$body" > "${out:-/dev/null}"
printf '%s' "${FAKE_HTTP:-200}"
FAKE
chmod +x "$SHIM/shopify" "$SHIM/curl"

run_gql() { # runs the real script with shims; args pass through
  (cd "$GQLDIR" && PATH="$SHIM:$PATH" SHOPIFY_ADMIN_TOKEN=test-token "$BASH_BIN" "$GQL" --store test-store "$@")
}

# G1 (bug): a mutation whose execute was attempted and failed must NOT fall back
rc=0; M="$TMP/m1"; CURL_MARKER="$M" FAKE_EXEC_MODE=garbage \
  run_gql --query mutation.graphql >"$O" 2>"$E" || rc=$?
assert G1-mutation-no-fallback 3 "$rc" "$E" "store_execute_failed_mutation"
if [ ! -f "$M" ]; then ok; else bad G1b-curl-untouched "token engine WAS invoked after a failed mutation execute"; fi

# G2: a query in the same situation still falls back (availability failure)
rc=0; M="$TMP/m2"; CURL_MARKER="$M" FAKE_EXEC_MODE=garbage \
  run_gql --query query.graphql >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -q '"ok":true' "$O" && [ -f "$M" ]; then ok; else bad G2-query-fallback "rc=$rc out=$(cat "$O")"; fi

# G3 (bug): non-2xx HTTP exits non-zero with error=http_<code>, body off stdout
rc=0; M="$TMP/m3"; CURL_MARKER="$M" FAKE_HTTP=401 FAKE_HTTP_BODY='<html>unauthorized</html>' \
  run_gql --engine token --query query.graphql >"$O" 2>"$E" || rc=$?
assert G3-http-401 5 "$rc" "$E" "error=http_401"
if [ ! -s "$O" ]; then ok; else bad G3b-stdout-clean "HTML body leaked to stdout: $(cat "$O")"; fi

# G4: auth-missing is a PRE-execution failure — mutations may still fall back
rc=0; M="$TMP/m4"; CURL_MARKER="$M" FAKE_EXEC_MODE=noauth \
  run_gql --query mutation.graphql >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -q '"ok":true' "$O" && [ -f "$M" ]; then ok; else bad G4-noauth-fallback "rc=$rc out=$(cat "$O")"; fi

# G5 (bug): --variables-file reaches the request body
rc=0; M="$TMP/m5"; CURL_MARKER="$M" \
  run_gql --engine token --query query.graphql --variables-file vars.json >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -q '"variables":{"k":"v"}' "$M.body"; then ok; else bad G5-variables-file "rc=$rc body=$(cat "$M.body" 2>/dev/null)"; fi

# G6: --variables and --variables-file together are refused
rc=0; run_gql --query query.graphql --variables '{}' --variables-file vars.json >"$O" 2>"$E" || rc=$?
assert G6-conflicting-flags 2 "$rc" "$E" "error=conflicting_flags"

# ---- 2026-07 token audit: --out summary + fallback-note quieting ----

# G7: --out swaps the envelope for a summary line; the file holds the envelope
rc=0; run_gql --engine token --query query.graphql --out "$TMP/env7.json" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^ok=1 bytes=[0-9]* out=.*errors=none' "$O" \
   && ! grep -q '"data"' "$O" && grep -q '"data"' "$TMP/env7.json"; then ok
else bad G7-out-summary "rc=$rc out=$(cat "$O")"; fi

# G8: a GraphQL-errors envelope under --out carries the first error's head in the summary
rc=0; FAKE_HTTP_BODY='{"errors":[{"message":"Field xyz is missing on Shop"}]}' \
  run_gql --engine token --query query.graphql --out "$TMP/env8.json" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -q 'errors=Field xyz is missing' "$O"; then ok
else bad G8-out-errors-head "rc=$rc out=$(cat "$O")"; fi

# G9: an unwritable --out path is a hard stop, not a silent success
rc=0; run_gql --engine token --query query.graphql --out "$TMP/no/such/dir/x.json" >"$O" 2>"$E" || rc=$?
assert G9-out-write-failed 5 "$rc" "$E" "error=out_write_failed"

# G10: the store engine's wrapped envelope also lands in --out
rc=0; FAKE_EXEC_MODE=ok run_gql --query query.graphql --out "$TMP/env10.json" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^ok=1 ' "$O" && grep -q '"data":{"ok":true}' "$TMP/env10.json"; then ok
else bad G10-store-out "rc=$rc out=$(cat "$O") file=$(cat "$TMP/env10.json" 2>/dev/null)"; fi

# G11: the fallback note prints in full once per store, then shortens to note=engine=token
QT="$TMP/quiet-tmpdir"; mkdir -p "$QT"
rc=0; TMPDIR="$QT" run_gql --query query.graphql >"$O" 2>"$E" || rc=$?
assert G11-first-run-full 0 "$rc" "$E" "store_execute unavailable"
rc=0; TMPDIR="$QT" run_gql --query query.graphql >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -q 'note=engine=token' "$E" && ! grep -q 'store_execute unavailable' "$E"; then ok
else bad G11b-second-run-short "err=$(head -c 200 "$E" | tr '\n' ' ')"; fi

# G12: SHOPIFY_ADMIN_GQL_QUIET forces the short note even on a first run
QT2="$TMP/quiet-tmpdir2"; mkdir -p "$QT2"
rc=0; TMPDIR="$QT2" SHOPIFY_ADMIN_GQL_QUIET=1 run_gql --query query.graphql >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -q 'note=engine=token' "$E" && ! grep -q 'store_execute unavailable' "$E"; then ok
else bad G12-quiet-env "err=$(head -c 200 "$E" | tr '\n' ' ')"; fi

# G12b: QUIET=0 means OFF — the first-run full note (with the store-auth remediation) prints
QT3="$TMP/quiet-tmpdir3"; mkdir -p "$QT3"
rc=0; TMPDIR="$QT3" SHOPIFY_ADMIN_GQL_QUIET=0 run_gql --query query.graphql >"$O" 2>"$E" || rc=$?
assert G12b-quiet-zero-off 0 "$rc" "$E" "store_execute unavailable"

# G13: --out pointing at an existing directory is a clean hard stop, not a stray cp + wc abort
mkdir -p "$TMP/outdir"
rc=0; run_gql --engine token --query query.graphql --out "$TMP/outdir" >"$O" 2>"$E" || rc=$?
assert G13-out-is-dir 5 "$rc" "$E" "error=out_write_failed"

# ---------------------------------------- create-preview-theme.sh cap classifier --
CAP_RE='theme limit|maximum number of themes|too many themes'
if grep -qF "$CAP_RE" "$CPT"; then ok; else bad C1-pattern-in-script "cap regex in the test drifted from the script"; fi
if printf 'You have reached your theme limit.\n' | grep -qiE "$CAP_RE"; then ok; else bad C2-real-cap "true cap message not classified"; fi
if printf 'The maximum number of themes has been reached\n' | grep -qiE "$CAP_RE"; then ok; else bad C3-real-cap2 "true cap message not classified"; fi
if printf 'Error pushing theme: rate limit exceeded, too many requests\n' | grep -qiE "$CAP_RE"; then
  bad C4-rate-limit-fp "rate-limit stderr still classified as theme cap"
else ok; fi

# ------------------------------------------- fix-breaking-changes banner handling --
FB="$TMP/fb"; mkdir -p "$FB/templates/customers" "$FB/config" "$FB/scripts"
printf '/* banner\n * auto-generated by Shopify\n*/\n{"current":{"x":1}}\n' > "$FB/config/settings_data.json"
printf '{"sections":{}}\n' > "$FB/templates/index.json"
printf '{"sections":{}}\n' > "$FB/templates/customers/account.json"
cp "$FBC" "$FB/scripts/fix-breaking-changes.js"
rc=0; (cd "$FB" && node scripts/fix-breaking-changes.js) >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && ! grep -q 'Error processing' "$O" "$E"; then ok; else bad F1-banner-config "rc=$rc :: $(grep 'Error processing' "$O" "$E" | head -2)"; fi
if head -1 "$FB/config/settings_data.json" | grep -q '/\* banner'; then ok; else bad F2-banner-preserved "banner lost: $(head -1 "$FB/config/settings_data.json")"; fi

# ---------------------------------------- json-slim.cjs CLI on a JSONL file (M9b final contract) --
# A JSONL FILE via the CLI is NEVER compressed and its body is NEVER printed, at ANY size. The CLI
# always emits a PROFILE (row/parse-fail counts, per-key stats, head/tail/reservoir samples) + a
# guidance block over the ORIGINAL (readline filter template + sed/grep). ≤8 MB profiles the in-memory
# rows; >8 MB streams via readline — SAME output shape. No fnd-crush-* / fnd-slim-out spill for a JSONL
# run. A NON-JSONL JSON document keeps the old slim behavior (+ the 48 KB output cap). All in-tmp.
SLIM="$ROOT/plugins/fnd/scripts/json-slim.cjs"
JLD="$TMP/jsonl"; mkdir -p "$JLD"

# J1: a SMALL (60-row) unique-entity JSONL → PROFILE + guidance, NEVER the crushed array body (no
# _ccr_dropped / <<full= sentinel — crush never ran) and no handback line; a dir diff before/after
# proves NO fnd-crush-*/fnd-slim-out-* spill is written for a JSONL run.
JLSMALL="$JLD/small.jsonl"
node -e '
  const fs=require("fs");
  const rows=Array.from({length:60},(_,i)=>JSON.stringify({id:i,tok:`unique-${i}-${(i*2654435761>>>0).toString(36)}`,n:i*7+1,ok:true}));
  fs.writeFileSync(process.argv[1], rows.join("\n")+"\n");
' "$JLSMALL"
SMD="$JLD/smallout"; mkdir -p "$SMD"
before="$(ls "$SMD")"
rc=0; FND_MCP_SLIM_DIR="$SMD" node "$SLIM" "$JLSMALL" >"$O" 2>"$E" || rc=$?
after="$(ls "$SMD")"
spills=$(ls "$SMD" 2>/dev/null | grep -cE '^fnd-(crush|slim-out)-' || true)
if [ "$rc" -eq 0 ] && grep -q '"profile":true' "$O" && grep -q 'readline' "$O" && grep -q 'sed -n' "$O" \
   && grep -q "$JLSMALL" "$O" && ! grep -q 'nothing to compress' "$O" \
   && ! grep -q '_ccr_dropped' "$O" && ! grep -q '<<full=' "$O" \
   && [ "$spills" -eq 0 ] && [ "$before" = "$after" ]; then ok
else bad J1-jsonl-small-profile "rc=$rc spills=$spills head=$(head -c 160 "$O")"; fi

# J2: a real-file-shaped bulk JSONL (id/handle/children, like the ELC store dump) → PROFILE with per-key
# stats for those keys + a first-rows sample, stdout ≤ 10 KB, never the crushed array body.
JLREAL="$JLD/real.jsonl"
node -e '
  const fs=require("fs");
  const rows=Array.from({length:500},(_,i)=>JSON.stringify({id:`gid://shopify/Product/${1000+i}`,handle:`product-${i}`,children:i%3?null:[i],ordered:null,bundleRefs:null}));
  fs.writeFileSync(process.argv[1], rows.join("\n")+"\n");
' "$JLREAL"
rc=0; FND_MCP_SLIM_DIR="$JLD" node "$SLIM" "$JLREAL" >"$O" 2>"$E" || rc=$?
outb=$(wc -c < "$O" | tr -d ' ')
if [ "$rc" -eq 0 ] && grep -q '"profile":true' "$O" && grep -q '"handle"' "$O" && grep -q '"children"' "$O" \
   && grep -q 'product-0' "$O" && grep -q "$JLREAL" "$O" && [ "$outb" -le 10240 ] \
   && ! grep -q 'nothing to compress' "$O"; then ok
else bad J2-jsonl-real-profile "rc=$rc outb=$outb head=$(head -c 160 "$O")"; fi

# J3: --jq 0.<key> still addresses a single value on a ≤8 MB JSONL file (parseJsonl before the walk)
rc=0; jqout="$(FND_MCP_SLIM_DIR="$JLD" node "$SLIM" --jq 0.handle "$JLREAL" 2>/dev/null)" || rc=$?
if [ "$rc" -eq 0 ] && [ "$jqout" = '"product-0"' ]; then ok; else bad J3-jsonl-jq "rc=$rc out=$jqout"; fi

# J4: a truncated JSONL (last line cut mid-object) is NOT a JSONL profile — parseJsonl declines it, so it
# falls to the non-json path handback (read the file directly).
JLBAD="$JLD/broken.jsonl"
node -e '
  const fs=require("fs");
  const good=fs.readFileSync(process.argv[1],"utf8").split("\n").filter(Boolean);
  const last=good.pop(); good.push(last.slice(0, Math.floor(last.length/2)));  // cut mid-object → invalid
  fs.writeFileSync(process.argv[2], good.join("\n")+"\n");
' "$JLREAL" "$JLBAD"
rc=0; FND_MCP_SLIM_DIR="$JLD" node "$SLIM" "$JLBAD" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -q 'nothing to compress' "$O" && grep -q "$JLBAD" "$O" && ! grep -q '"profile"' "$O"; then ok
else bad J4-jsonl-truncated-handback "rc=$rc out=$(head -c 120 "$O")"; fi

# J5: a NON-JSONL JSON document (one big array, not line-delimited) keeps the UNCHANGED slim behavior —
# a compressed array on stdout, never a profile and never a handback.
JSONARR="$JLD/array.json"
node -e '
  const fs=require("fs");
  const arr=Array.from({length:500},(_,i)=>({id:i,status:"ACTIVE",vendor:"MAC",note:null}));
  fs.writeFileSync(process.argv[1], JSON.stringify(arr));
' "$JSONARR"
inb=$(wc -c < "$JSONARR" | tr -d ' ')
rc=0; FND_MCP_SLIM_DIR="$JLD" node "$SLIM" "$JSONARR" >"$O" 2>"$E" || rc=$?
outb=$(wc -c < "$O" | tr -d ' ')
if [ "$rc" -eq 0 ] && ! grep -q '"profile":true' "$O" && ! grep -q 'nothing to compress' "$O" \
   && ! grep -q 'slimmed output' "$O" && [ "$outb" -lt "$inb" ] \
   && node -e 'process.exit(Array.isArray(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")))?0:1)' "$O"; then ok
else bad J5-nonjsonl-json-unchanged "rc=$rc in=$inb out=$outb head=$(head -c 120 "$O")"; fi

# ---------------------------------------- json-slim.cjs whale gates (M9b) --
# Gate B: a JSONL file past the 8 MB stream gate is PROFILED via readline (never readFileSync'd) — the
# SAME profile+guidance shape the ≤8 MB path emits, bounded stdout. Gate A: a huge NON-JSONL document
# over the 48 KB output cap is spilled + summarized. Both CLI-only; the hook never sees these sizes.

# J6: a ~9 MB JSONL streams to a bounded PROFILE (not the whole array), stdout ≤ 10 KB, followed by the
# shared guidance block (readline filter template + sed/grep single-row hint), no fnd-slim-out spill,
# and fast (elapsed ≤ 3 s — streaming, not a full parse of every row into memory).
JLBIG="$JLD/whale.jsonl"
node -e '
  const fs=require("fs"), ws=fs.createWriteStream(process.argv[1]);
  let n=0; const T=110000;  // ~9 MB of small rows (fast to generate)
  (function w(){ let ok=true; while(ok && n<T){ n++; ok=ws.write(JSON.stringify({id:n,handle:`product-${n}`,status:n%7?"ACTIVE":"DRAFT",vendor:"MAC",price:(n%100)+0.99})+"\n"); } n<T ? ws.once("drain",w) : ws.end(); })();
' "$JLBIG"
bigb=$(wc -c < "$JLBIG" | tr -d ' ')
start=$(date +%s)
rc=0; FND_MCP_SLIM_DIR="$JLD" node "$SLIM" "$JLBIG" >"$O" 2>"$E" || rc=$?
elapsed=$(( $(date +%s) - start ))
outb=$(wc -c < "$O" | tr -d ' ')
if [ "$rc" -eq 0 ] && [ "$bigb" -gt 8388608 ] && grep -q '"profile":true' "$O" && grep -q 'sed -n' "$O" \
   && grep -q 'readline' "$O" && grep -q "$JLBIG" "$O" \
   && [ "$outb" -le 10240 ] && [ "$elapsed" -le 3 ] && ! grep -q 'fnd-slim-out' "$O"; then ok
else bad J6-jsonl-whale-profile "rc=$rc bigb=$bigb outb=$outb elapsed=${elapsed}s head=$(head -c 120 "$O")"; fi

# J7: --jq on the same >8 MB file REFUSES with guidance instead of loading a gigabyte (no jq walk)
rc=0; FND_MCP_SLIM_DIR="$JLD" node "$SLIM" --jq 0.status "$JLBIG" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -q 'refusing to load' "$O" && grep -q 'sed -n' "$O" && ! grep -q '"profile"' "$O"; then ok
else bad J7-jsonl-whale-jq-refuse "rc=$rc head=$(head -c 160 "$O")"; fi

# J8: a huge NON-JSONL JSON document whose slimmed body still exceeds the 48 KB inline cap is spilled to
# an fnd-slim-out-* file + summarized, never dumped inline (Gate A, the one-huge-document case).
BIGDOC="$JLD/bigdoc.json"
node -e '
  const fs=require("fs");
  const o={}; for(let i=0;i<3000;i++) o[`field_${i}`]=`value string number ${i} kept intact`;
  fs.writeFileSync(process.argv[1], JSON.stringify(o));
' "$BIGDOC"
BDD="$JLD/bigdocout"; mkdir -p "$BDD"
rc=0; FND_MCP_SLIM_DIR="$BDD" node "$SLIM" "$BIGDOC" >"$O" 2>"$E" || rc=$?
slimspill=$(ls "$BDD" 2>/dev/null | grep -c '^fnd-slim-out-' || true)
if [ "$rc" -eq 0 ] && grep -q 'exceeds the' "$O" && grep -q 'spilled, not printed' "$O" \
   && grep -q "$BIGDOC" "$O" && [ "$slimspill" -eq 1 ] && ! grep -q '"profile"' "$O"; then ok
else bad J8-nonjsonl-gateA-spill "rc=$rc spills=$slimspill head=$(head -c 160 "$O")"; fi

# J9: the CLI exit sweep prunes a stale fnd-slim-out-* while keeping a fresh one (M5 sweep extended);
# any CLI run triggers the sweep — here a JSONL profile run (which itself writes no spill).
SWD="$JLD/sweepout"; mkdir -p "$SWD"
stale="$SWD/fnd-slim-out-STALE.json"; printf '[]' > "$stale"; touch -t 200001010000 "$stale"
fresh="$SWD/fnd-slim-out-FRESH.json"; printf '[]' > "$fresh"
FND_MCP_SLIM_DIR="$SWD" node "$SLIM" "$JLREAL" >/dev/null 2>&1
if [ ! -f "$stale" ] && [ -f "$fresh" ]; then ok
else bad J9-slim-out-sweep "stale-gone=$([ -f "$stale" ] && echo no || echo yes) fresh-kept=$([ -f "$fresh" ] && echo yes || echo no)"; fi

# J10: `--jq .` (identity) on a ≤8 MB JSONL PROFILES like a no-jq run — identity selects the WHOLE file,
# so it must NOT crush the reshaped array to a body + spill. Regression: a dot-path that filters to zero
# segments (`.` / `..`) bypassed the profile guard and routed the full row array through slim().
J10D="$JLD/jqid"; mkdir -p "$J10D"
before="$(ls "$J10D")"
rc=0; FND_MCP_SLIM_DIR="$J10D" node "$SLIM" --jq . "$JLREAL" >"$O" 2>"$E" || rc=$?
after="$(ls "$J10D")"
spills=$(ls "$J10D" 2>/dev/null | grep -cE '^fnd-(crush|slim-out)-' || true)
if [ "$rc" -eq 0 ] && grep -q '"profile":true' "$O" && ! grep -q '_ccr_dropped' "$O" && ! grep -q '<<full=' "$O" \
   && [ "$spills" -eq 0 ] && [ "$before" = "$after" ]; then ok
else bad J10-jq-identity-profiles "rc=$rc spills=$spills head=$(head -c 120 "$O")"; fi

# J11: the guidance commands survive a path with SPACES and a DOUBLE-QUOTE — the node -e path is
# JSON-escaped for the JS string literal and shell single-quoted for the shell; sed/grep tokens are
# single-quoted too. Regression: unquoted interpolation split the path on spaces / broke the JS string.
WQD="$JLD/we ir\"d"; mkdir -p "$WQD"; WQF="$WQD/da ta.jsonl"
printf '{"a":1,"handle":"HH1"}\n{"a":2,"handle":"HH2"}\n' > "$WQF"
rc=0; FND_MCP_SLIM_DIR="$JLD" node "$SLIM" "$WQF" >"$O" 2>"$E" || rc=$?
# adapt the node -e template (replace the /* filter */ placeholder with `true`) and run it verbatim
NODELINE="$(grep 'node -e' "$O" | sed 's#/\* filter[^*]*\*/#true#')"
nout="$(eval "$NODELINE" 2>/dev/null || true)"
if [ "$rc" -eq 0 ] && printf '%s' "$nout" | grep -q 'HH1' && printf '%s' "$nout" | grep -q 'HH2' \
   && grep -Fq "sed -n '<N>p' '$WQF'" "$O" && grep -Fq "grep <pattern> '$WQF'" "$O"; then ok
else bad J11-guidance-shell-safe "rc=$rc node=[$nout]"; fi

# J12: a >8 MB NON-JSONL single JSON document hits Gate B on SIZE but is not a row stream — it gets an
# honest hand-back, NOT a misleading rows:0 profile. Regression: Gate B profiled it as JSONL → rows:0.
BIGND="$JLD/bignonjsonl.json"
node -e '
  const fs=require("fs"), ws=fs.createWriteStream(process.argv[1]);
  ws.write("{"); for(let i=0;i<300000;i++){ ws.write((i?",":"")+JSON.stringify("field_"+i)+":"+JSON.stringify("value string "+i)); } ws.write("}");
  ws.end();
' "$BIGND"
bignb=$(wc -c < "$BIGND" | tr -d ' ')
BNDD="$JLD/bigndout"; mkdir -p "$BNDD"
rc=0; FND_MCP_SLIM_DIR="$BNDD" node "$SLIM" "$BIGND" >"$O" 2>"$E" || rc=$?
spills=$(ls "$BNDD" 2>/dev/null | grep -cE '^fnd-' || true)
if [ "$rc" -eq 0 ] && [ "$bignb" -gt 8388608 ] && grep -q 'NOT a JSONL row stream' "$O" && grep -q "$BIGND" "$O" \
   && ! grep -q '"profile":true' "$O" && ! grep -q '"rows":0' "$O" && [ "$spills" -eq 0 ]; then ok
else bad J12-big-nonjsonl-notice "rc=$rc bignb=$bignb spills=$spills head=$(head -c 160 "$O")"; fi

# ---------------------------------------------- json-slim.cjs: log/build-output compressor (M10) --
# L1: the CLI on a synthetic 2000-line loop-warning console log (+ a handful of ERRORs and a Python
# traceback) compresses ≥95% to ≤~30 lines — every ERROR + the trace head kept, the looping WARN
# deduped `×N`, an omitted-count trailer that reports lines ACTUALLY omitted (the 5 kept ERRORs are
# NOT listed as omitted; findings 4 & 6), and a final `original: <path>` line naming the on-disk
# recovery source. This is signal-selection (the opposite of the JSONL profile path).
LOGD="$TMP/logslim"; mkdir -p "$LOGD"
LOGF="$LOGD/loop.log"
node -e '
  const l=[];
  for(let i=0;i<2000;i++) l.push("WARNING: slow render loop detected, skipping frame :: retrying now");
  for(const e of ["failed to load texture atlas","WebGL context lost","shader compilation failed","out of memory allocating framebuffer","fatal renderer teardown"]) l.push("ERROR: "+e);
  l.push("Traceback (most recent call last):");
  l.push("  File \"renderer.py\", line 88, in draw");
  l.push("ValueError: invalid frame buffer handle");
  require("fs").writeFileSync(process.argv[1], l.join("\n"));
' "$LOGF"
inb=$(wc -c < "$LOGF" | tr -d ' ')
rc=0; FND_MCP_SLIM_DIR="$LOGD" node "$SLIM" "$LOGF" >"$O" 2>"$E" || rc=$?
outb=$(wc -c < "$O" | tr -d ' ')
outlines=$(wc -l < "$O" | tr -d ' ')
errkept=$(grep -c 'ERROR:' "$O" || true)
pct=$(node -e "console.log(100*(1-$outb/$inb))")
if [ "$rc" -eq 0 ] && [ "$outlines" -le 30 ] && [ "$errkept" -eq 5 ] \
   && grep -q 'retrying now ×2000' "$O" \
   && grep -q 'Traceback (most recent call last):' "$O" \
   && grep -q 'ValueError: invalid frame buffer handle' "$O" \
   && grep -Eq '\[[0-9]+ lines omitted: [0-9]+ WARN\]' "$O" \
   && ! grep -Eq 'lines omitted:[^]]*ERROR' "$O" \
   && grep -Fq "original: $LOGF" "$O" \
   && node -e "process.exit($outb/$inb < 0.05 ? 0 : 1)"; then ok
else bad L1-log-cli-compress "rc=$rc lines=$outlines errkept=$errkept pct=$pct head=$(head -c 160 "$O")"; fi

# L2: a prose / markdown docs-chunk file is NOT log-shaped — it passes through byte-identical (the CLI
# emits the non-json handback naming the file, never a lossy compression).
DOCF="$LOGD/doc.md"
printf '## Fetching products\n\nUse the products connection to page through a catalogue.\nPagination is cursor-based; keep requesting until hasNextPage is false.\nSee the reference for the full list of connection fields.\n' > "$DOCF"
rc=0; FND_MCP_SLIM_DIR="$LOGD" node "$SLIM" "$DOCF" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -Fq "read the file directly: $DOCF" "$O" && ! grep -q 'lines omitted' "$O"; then ok
else bad L2-docs-passthrough "rc=$rc head=$(head -c 160 "$O")"; fi

# L3 (finding 1): a 50+ line troubleshooting markdown doc that MENTIONS error/failed/warning words in
# ordinary prose is NOT a log — the CLI must hand it back byte-identical, never compress+mangle it.
TSHF="$LOGD/tshoot.md"
node -e '
  const md=["# Troubleshooting the checkout integration","","When the checkout call fails, the storefront logs an error and the customer","sees a generic failure page. Below are the common causes and how to resolve.","","## Symptoms","","- A 500 error from the payment gateway means the request failed validation.","- A warning in the console about a missing metafield is usually harmless.","- If the theme editor shows a failed publish, re-save the section and retry.",""];
  for(let i=0;i<44;i++) md.push("Paragraph "+i+": the request occasionally fails and logs an error, but a warning here is expected and no failure is surfaced to the buyer.");
  require("fs").writeFileSync(process.argv[1], md.join("\n"));
' "$TSHF"
inb=$(wc -c < "$TSHF" | tr -d ' ')
rc=0; FND_MCP_SLIM_DIR="$LOGD" node "$SLIM" "$TSHF" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -Fq "read the file directly: $TSHF" "$O" && ! grep -q 'lines omitted' "$O"; then ok
else bad L3-error-prose-passthrough "rc=$rc inb=$inb head=$(head -c 160 "$O")"; fi

# ---------------------------------------------- json-slim.cjs: fenced-payload unwrap (M11) --
# A tool wraps its payload in prose + a markdown fence ("Script ran…\n```json\n<payload>\n```",
# chrome-devtools evaluate_script). The CLI must see THROUGH the wrapper: unwrap the dominant fence,
# re-run the pipeline on the body, keep the preamble on top. Real docs with small code blocks stay
# byte-identical; a fenced JSONL body still PROFILES (never crushed) with offset-corrected guidance.
FND="$TMP/fence"; mkdir -p "$FND"

# F1: a fenced JSON wrapper whose slimmed body still exceeds the 48 KB inline cap → Gate A spill +
# summary naming BOTH the original wrapper and the slimmed spill (the real-whale shape), never
# "nothing to compress", stdout small.
F1F="$FND/whale.txt"
node -e '
  const fs=require("fs");
  const prod=(i)=>{const o={id:i}; for(let j=0;j<200;j++) o["f"+j]= j%2 ? null : "value-"+i+"-"+j+"-pad"; return o;};
  const obj={products:Array.from({length:60},(_,i)=>prod(i))};
  fs.writeFileSync(process.argv[1], "Script ran on page and returned:\n```json\n"+JSON.stringify(obj)+"\n```");
' "$F1F"
F1OUT="$FND/f1out"; mkdir -p "$F1OUT"
rc=0; FND_MCP_SLIM_DIR="$F1OUT" node "$SLIM" "$F1F" >"$O" 2>"$E" || rc=$?
outb=$(wc -c < "$O" | tr -d ' ')
slimspill=$(ls "$F1OUT" 2>/dev/null | grep -c '^fnd-slim-out-' || true)
if [ "$rc" -eq 0 ] && grep -q 'spilled, not printed' "$O" && grep -q "$F1F" "$O" \
   && [ "$slimspill" -eq 1 ] && [ "$outb" -le 1200 ] && ! grep -q 'nothing to compress' "$O" \
   && ! grep -q '"profile"' "$O"; then ok
else bad F1-fence-gateA "rc=$rc outb=$outb spills=$slimspill head=$(head -c 160 "$O")"; fi

# F1b–F1d (M11): the Gate-A spill for a FENCED whale must be valid JSON (spill the JSON body, NOT
# the "Script ran…" prose preamble), the handback must sample a REAL row (not "shape: (none)"), and the
# advertised `--jq <path> <spill>` recovery must not error on the preamble. A spill carrying the
# preamble would make the sampler + the --jq command both hit `input is not valid JSON`.
F1SPILL="$F1OUT/$(ls "$F1OUT" 2>/dev/null | grep '^fnd-slim-out-' | head -1)"
if [ -f "$F1SPILL" ] && node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$F1SPILL" 2>/dev/null; then ok
else bad F1b-spill-valid-json "spill not valid JSON: $F1SPILL"; fi
if grep -Eq '(shape|first row): \{' "$O" && ! grep -q '(none)' "$O"; then ok
else bad F1c-sample-real "no real sample: $(grep -E 'shape|first row' "$O" | head -1)"; fi
rc=0; node "$SLIM" --jq products "$F1SPILL" >/dev/null 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && ! grep -q 'input is not valid JSON' "$E"; then ok
else bad F1d-jq-spill "rc=$rc err=$(head -c 120 "$E")"; fi

# F5 (M11): `--jq <path>` on the ORIGINAL fenced wrapper file (not just the spill) must unwrap the
# dominant fence and narrow into the body — without the unwrap, the --jq path JSON.parses the raw file
# and errors on the prose preamble ("input is not valid JSON: Unexpected token 'S'").
rc=0; node "$SLIM" --jq products "$F1F" >/dev/null 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && ! grep -q 'input is not valid JSON' "$E"; then ok
else bad F5-jq-original-fence "rc=$rc err=$(head -c 120 "$E")"; fi

# F6 (M11): a >8 MB FENCED JSONL whale hits Gate B (stream-profile). The guidance must be offset-
# aware — rows begin at line 3, the readline loader tolerates the wrapper (try/parse), parseFailures is
# 0 — so the emitted loader does not crash on the prose/fence lines. A raw (non-offset) profile would
# count the wrapper as parseFailures and emit a STRICT loader that throws on the first line.
F6F="$FND/big-fenced.jsonl"
node -e '
  const fs=require("fs");
  const parts=["Script returned:\n```jsonl\n"];
  for(let i=0;i<120000;i++) parts.push(JSON.stringify({id:i,handle:"product-"+i,status:"ACTIVE",vendor:"MAC",title:"Item number "+i})+"\n");
  parts.push("```\n");
  fs.writeFileSync(process.argv[1], parts.join(""));
' "$F6F"
f6sz=$(wc -c < "$F6F" | tr -d ' ')
F6OUT="$FND/f6out"; mkdir -p "$F6OUT"
rc=0; FND_MCP_SLIM_DIR="$F6OUT" node "$SLIM" "$F6F" >"$O" 2>"$E" || rc=$?
# adapt the emitted offset-aware loader (predicate → keep only the first + last id) and run it: it must
# emit both handles despite the wrapper lines, proving the tolerant loader works over the fenced whale.
NL6="$(grep 'node -e' "$O" | sed 's#/\* filter[^*]*\*/#(o.id<1||o.id>119998)#')"
n6="$(eval "$NL6" 2>/dev/null || true)"
if [ "$rc" -eq 0 ] && [ "$f6sz" -gt 8388608 ] && grep -q '"profile":true' "$O" \
   && grep -q 'begin at line 3' "$O" && grep -q 'try{o=JSON.parse' "$O" \
   && grep -q '"parseFailures":0' "$O" \
   && printf '%s' "$n6" | grep -q 'product-0' && printf '%s' "$n6" | grep -q 'product-119999'; then ok
else bad F6-big-fenced-jsonl "rc=$rc sz=$f6sz n6=[$(printf '%s' "$n6" | head -c 40)] head=$(head -c 200 "$O")"; fi

# F7 (M11): a substantive trailer AFTER the closing fence (e.g. a truncation note) must be carried
# into the compressed output, not silently dropped — slim() re-emits preamble + body + trailer.
F7F="$FND/trailer.txt"
node -e '
  const fs=require("fs");
  const arr=Array.from({length:500},(_,i)=>({id:i,status:"ACTIVE",vendor:"MAC",note:null}));
  fs.writeFileSync(process.argv[1], "Result:\n```json\n"+JSON.stringify({products:arr})+"\n```\nNOTE: results were truncated at 500 rows for safety.");
' "$F7F"
F7OUT="$FND/f7out"; mkdir -p "$F7OUT"
rc=0; FND_MCP_SLIM_DIR="$F7OUT" node "$SLIM" "$F7F" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ "$(head -1 "$O")" = "Result:" ] \
   && grep -Fq 'NOTE: results were truncated at 500 rows for safety.' "$O" \
   && ! grep -q 'nothing to compress' "$O"; then ok
else bad F7-trailer-preserved "rc=$rc first=$(head -1 "$O") tail=$(tail -1 "$O")"; fi

# F2: a fenced JSON wrapper whose crushed body fits under the cap → the preamble is emitted on TOP,
# then the crushed JSON inline (smaller than the input), no spill, never "nothing to compress".
F2F="$FND/small.txt"
node -e '
  const fs=require("fs");
  const arr=Array.from({length:500},(_,i)=>({id:i,status:"ACTIVE",vendor:"MAC",note:null}));
  fs.writeFileSync(process.argv[1], "Script ran on page and returned:\n```json\n"+JSON.stringify({products:arr})+"\n```");
' "$F2F"
inb=$(wc -c < "$F2F" | tr -d ' ')
F2OUT="$FND/f2out"; mkdir -p "$F2OUT"
rc=0; FND_MCP_SLIM_DIR="$F2OUT" node "$SLIM" "$F2F" >"$O" 2>"$E" || rc=$?
outb=$(wc -c < "$O" | tr -d ' ')
firstline="$(head -1 "$O")"
crushspill=$(ls "$F2OUT" 2>/dev/null | grep -cE '^fnd-(crush|slim-out)-' || true)
if [ "$rc" -eq 0 ] && [ "$firstline" = "Script ran on page and returned:" ] && [ "$outb" -lt "$inb" ] \
   && ! grep -q 'nothing to compress' "$O" && ! grep -q '"profile":true' "$O" \
   && node -e 'const fs=require("fs");const t=fs.readFileSync(process.argv[1],"utf8").split("\n").slice(1).join("\n");process.exit(Array.isArray(JSON.parse(t).products)?0:1)' "$O"; then ok
else bad F2-fence-inline "rc=$rc first=[$firstline] in=$inb out=$outb spills=$crushspill"; fi

# F3: a markdown docs-chunk with a SMALL code block is not a dominant fence — byte-identical passthrough
# (the CLI hands the path back, never compresses/mangles it, never a profile).
F3F="$FND/doc.md"
printf '## Fetching products\n\nUse the products connection to page through a catalogue. Each edge exposes a cursor and a node id.\n```graphql\nquery { products(first: 10) { edges { node { id } } } }\n```\nPagination is cursor-based; keep requesting until hasNextPage is false. See the reference for the rest.\n' > "$F3F"
rc=0; FND_MCP_SLIM_DIR="$FND" node "$SLIM" "$F3F" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -Fq "read the file directly: $F3F" "$O" && ! grep -q 'lines omitted' "$O" \
   && ! grep -q '"profile"' "$O"; then ok
else bad F3-docs-passthrough "rc=$rc head=$(head -c 160 "$O")"; fi

# F4: a JSONL body wrapped in a fence via the CLI → PROFILE (never crushed), with the guidance's line
# hints CORRECTED for the wrapper offset (rows begin at line 3; loader skips 2 wrapper lines). No
# _ccr_dropped / <<full= (crush never ran), no spill. The offset-corrected readline template must run.
F4F="$FND/fenced.jsonl"
node -e '
  const fs=require("fs");
  const rows=Array.from({length:20},(_,i)=>JSON.stringify({id:`gid://shopify/Product/${1000+i}`,handle:`product-${i}`,children:i%3?null:[i]}));
  fs.writeFileSync(process.argv[1], "Bulk export returned:\n```jsonl\n"+rows.join("\n")+"\n```");
' "$F4F"
F4OUT="$FND/f4out"; mkdir -p "$F4OUT"
before="$(ls "$F4OUT")"
rc=0; FND_MCP_SLIM_DIR="$F4OUT" node "$SLIM" "$F4F" >"$O" 2>"$E" || rc=$?
after="$(ls "$F4OUT")"
spills=$(ls "$F4OUT" 2>/dev/null | grep -cE '^fnd-(crush|slim-out)-' || true)
# adapt the fence-aware node -e loader and run it — it must emit handles despite the prose/fence lines
NODELINE="$(grep 'node -e' "$O" | sed 's#/\* filter[^*]*\*/#true#')"
nout="$(eval "$NODELINE" 2>/dev/null || true)"
if [ "$rc" -eq 0 ] && grep -q '"profile":true' "$O" && grep -q 'inside a ```' "$O" \
   && grep -q 'begin at line 3' "$O" && grep -q "$F4F" "$O" \
   && ! grep -q '_ccr_dropped' "$O" && ! grep -q '<<full=' "$O" \
   && [ "$spills" -eq 0 ] && [ "$before" = "$after" ] \
   && printf '%s' "$nout" | grep -q 'product-0' && printf '%s' "$nout" | grep -q 'product-19'; then ok
else bad F4-fenced-jsonl-profile "rc=$rc spills=$spills nout=[$(printf '%s' "$nout" | head -c 40)] head=$(head -c 200 "$O")"; fi

# ---------------------------------------------- json-slim.cjs: --report over the debug log (M12) --
# `--report [logfile] [--since <ISO>]` aggregates the FND_MCP_SLIM_DEBUG JSONL log. The synthetic log
# below covers every family the report must speak about: a compressed hook event, a passthrough, a
# platform-overflow PAIRED with a later CLI run over the same spill path, and an UNPAIRED overflow —
# the missed whale, the one number the two-lever decision hangs on. It must surface, the paired one
# must not, and the output must stay short enough to read (≤ 40 lines). The CLI run's savings ride on
# the `cli runs:` aggregate line, never in the (MCP-tool) top-tools ranking — see R6.
RPD="$TMP/report"; mkdir -p "$RPD"
RPLOG="$RPD/fnd-mcp-slim-debug.log"
cat > "$RPLOG" <<'RPEOF'
{"ts":"2026-07-24T10:00:00.000Z","project":"elc","entry":"hook","tool":"mcp__a__getJiraIssue","decision":"compressed","reason":null,"bytes_in":9062,"bytes_out":5318,"pct":41.3,"stages":["adf","noise","crush"],"spill":"/tmp/fnd-mcp-slim-a.json","ms":7}
{"ts":"2026-07-24T10:05:00.000Z","project":"elc","entry":"hook","tool":"mcp__a__listFiles","decision":"passthrough","reason":"non-json","format":"text","bytes_in":52518,"bytes_out":52518,"pct":0,"stages":[],"spill":null,"ms":2}
{"ts":"2026-07-24T11:00:00.000Z","project":"elc","entry":"hook","tool":"mcp__x__evaluate_script","decision":"passthrough","reason":"platform-overflow","bytes_in":1463,"bytes_out":1463,"pct":0,"stages":[],"spill":"/p/tool-results/paired-whale.txt","ms":1}
{"ts":"2026-07-24T11:02:00.000Z","project":"elc","entry":"cli","tool":"/p/tool-results/paired-whale.txt","decision":"compressed","reason":null,"bytes_in":764124,"bytes_out":123048,"pct":83.9,"stages":["noise","crush"],"spill":null,"spill_out":"/tmp/fnd-slim-out-b.json","ms":36}
{"ts":"2026-07-24T12:00:00.000Z","project":"other","entry":"hook","tool":"mcp__x__list_network_requests","decision":"passthrough","reason":"platform-overflow","bytes_in":1400,"bytes_out":1400,"pct":0,"stages":[],"spill":"/p/tool-results/lonely-whale.txt","ms":1}
not json at all
RPEOF
rc=0; node "$SLIM" --report "$RPLOG" >"$O" 2>"$E" || rc=$?
lines=$(wc -l < "$O" | tr -d ' ')
# the missed-whale SECTION only (the paired whale still shows up above it as a top tool by bytes saved)
missed="$(sed -n '/missed whales/,$p' "$O")"
if [ "$rc" -eq 0 ] && [ "$lines" -le 40 ] && grep -Fq "$RPLOG" "$O" \
   && grep -Fq '5 events' "$O" && grep -Fq '(+1 unparseable)' "$O" \
   && grep -Fq 'compressed 2' "$O" && grep -Fq 'platform-overflow 2' "$O" \
   && grep -Fq 'no later json-slim run): 1 of 2' "$O" \
   && printf '%s' "$missed" | grep -Fq 'lonely-whale.txt' \
   && ! printf '%s' "$missed" | grep -Fq 'paired-whale.txt' \
   && grep -Fq 'elc:' "$O" && grep -Fq 'other:' "$O" \
   && grep -Fq 'cli runs: 1 · saved 641076 B (83.9%)' "$O"; then ok
else bad R1-report "rc=$rc lines=$lines out=$(head -c 400 "$O") err=$(head -c 120 "$E")"; fi

# R2: --since filters by timestamp (only the last event survives) and the header states the cutoff.
rc=0; node "$SLIM" --report "$RPLOG" --since 2026-07-24T11:30:00Z >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -Fq '1 events' "$O" && grep -Fq '[since 2026-07-24T11:30:00Z]' "$O" \
   && grep -Fq 'lonely-whale.txt' "$O" && ! grep -Fq 'getJiraIssue' "$O"; then ok
else bad R2-report-since "rc=$rc out=$(head -c 300 "$O")"; fi

# R3: a missing log / an unparseable --since are hard errors on stderr (exit 1), never a fake report.
rc=0; node "$SLIM" --report "$RPD/nope.log" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 1 ] && grep -Fq 'no debug log at' "$E"; then ok
else bad R3-report-missing-log "rc=$rc err=$(head -c 160 "$E")"; fi
rc=0; node "$SLIM" --report "$RPLOG" --since yesterday >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 1 ] && grep -Fq 'not a parseable date' "$E"; then ok
else bad R3b-report-bad-since "rc=$rc err=$(head -c 160 "$E")"; fi

# R4: bare `--report` (no path) defaults to <FND_MCP_SLIM_DIR>/fnd-mcp-slim-debug.log — the same file
# the hook and the CLI write, so the documented one-liner works with no argument.
rc=0; FND_MCP_SLIM_DIR="$RPD" node "$SLIM" --report >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -Fq '5 events' "$O"; then ok
else bad R4-report-default-path "rc=$rc out=$(head -c 200 "$O") err=$(head -c 120 "$E")"; fi

# R5 (M12b): `stubbed` is its own decision — the hook replaced a whale with a ~1 KB stub, so it counts
# toward the bytes saved (not as a passthrough that saved nothing) and gets its own line broken down by
# the branch it replaced. A stub nobody followed up on is a MODEL choice, reported for curiosity — never
# a missed whale (the instruction was inline, unlike a platform-overflow file).
RPLOG2="$RPD/stubbed.log"
cat > "$RPLOG2" <<'RPEOF'
{"ts":"2026-07-25T09:00:00.000Z","project":"elc","entry":"hook","tool":"mcp__x__evaluate_script","decision":"stubbed","reason":"non-json","format":"text","bytes_in":812000,"bytes_out":890,"pct":99.9,"stages":[],"spill":"/tmp/fnd-mcp-slim-followed.json","ms":24}
{"ts":"2026-07-25T09:01:00.000Z","project":"elc","entry":"cli","tool":"/tmp/fnd-mcp-slim-followed.json","decision":"compressed","reason":null,"bytes_in":812000,"bytes_out":91000,"pct":88.8,"stages":["noise","crush"],"spill":null,"ms":41}
{"ts":"2026-07-25T09:10:00.000Z","project":"elc","entry":"hook","tool":"mcp__a__getJiraIssue","decision":"stubbed","reason":"weak-gain","bytes_in":260000,"bytes_out":910,"pct":99.6,"stages":["adf","noise","crush"],"spill":"/tmp/fnd-mcp-slim-ignored.json","ms":33}
RPEOF
rc=0; node "$SLIM" --report "$RPLOG2" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -Fq 'stubbed 2' "$O" \
   && grep -Fq 'stubbed (spill-and-stub guard): 2 (non-json 1 · weak-gain 1), 1 with no later json-slim run' "$O" \
   && grep -Fq 'no later json-slim run): 0 of 0' "$O" \
   && ! grep -q 'passthrough reasons' "$O" \
   && grep -Fq '95.1% saved' "$O"; then ok
else bad R5-report-stubbed "rc=$rc out=$(head -c 500 "$O") err=$(head -c 120 "$E")"; fi

# R6: a CLI event's `tool` is the FILE it ran on, not an MCP tool name. Ranking the two together let a
# handful of whale files push every MCP tool out of the top-5 (and double-counted the notice + the CLI
# run of the same whale). Top tools is HOOK-only; CLI work gets one aggregate line.
RPLOG3="$RPD/cli-vs-hook.log"
: > "$RPLOG3"
for i in 1 2 3 4 5 6; do
  printf '{"ts":"2026-07-25T1%s:00:00.000Z","project":"elc","entry":"cli","tool":"/tmp/fnd-mcp-slim-%s.json","decision":"compressed","reason":null,"bytes_in":900000,"bytes_out":100000,"pct":88.9,"stages":["crush"],"spill":null,"ms":40}\n' "$i" "$i" >> "$RPLOG3"
done
cat >> "$RPLOG3" <<'RPEOF'
{"ts":"2026-07-25T17:00:00.000Z","project":"elc","entry":"hook","tool":"mcp__a__x","decision":"compressed","reason":null,"bytes_in":50000,"bytes_out":20000,"pct":60,"stages":["crush"],"spill":"/tmp/fnd-mcp-slim-h1.json","ms":5}
{"ts":"2026-07-25T18:00:00.000Z","project":"elc","entry":"hook","tool":"mcp__b__y","decision":"compressed","reason":null,"bytes_in":40000,"bytes_out":25000,"pct":37.5,"stages":["crush"],"spill":"/tmp/fnd-mcp-slim-h2.json","ms":5}
RPEOF
rc=0; node "$SLIM" --report "$RPLOG3" >"$O" 2>"$E" || rc=$?
# the ranking rows only (indent 4), so the slice does not depend on the optional `cli runs:` line
tops="$(awk '/top tools by bytes saved/{f=1;next} f && !/^    /{exit} f' "$O")"
if [ "$rc" -eq 0 ] \
   && printf '%s' "$tops" | grep -Fq 'mcp__a__x' && printf '%s' "$tops" | grep -Fq 'mcp__b__y' \
   && ! printf '%s' "$tops" | grep -Fq '/tmp/fnd-mcp-slim-' \
   && [ "$(grep -c 'cli runs:' "$O")" -eq 1 ] \
   && grep -Fq 'cli runs: 6 · saved 4800000 B (88.9%)' "$O"; then ok
else bad R6-report-cli-vs-hook "rc=$rc out=$(head -c 600 "$O") err=$(head -c 120 "$E")"; fi

echo "scripts-sim: $pass passed, $fail failed"
if [ "$fail" -gt 0 ]; then printf '%s' "$failures"; exit 1; fi
