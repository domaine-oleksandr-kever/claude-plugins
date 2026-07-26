#!/usr/bin/env bash
# Simulation harness for the bundled shell/node scripts (2026-07 audit, batch C).
# No network, no store: theme-json runs against a stub runner; shopify-admin-gql runs
# against PATH shims of `shopify` and `curl`. Exit 0 = all green.
set -u

# Hermetic env: a developer who exports FND_MCP_SLIM_DEBUG=1 / FND_MCP_SLIM_DIR to watch the log live
# would otherwise have json-slim drop a debug log into each case's spill directory, which the
# before/after directory diffs below read as an unexpected spill. Every case that needs either switch
# sets it explicitly on the invocation. The store/token vars are unset for the same reason and one
# more: both are read as an escape hatch by the scripts under test, so an exported real token would
# reach the fake CLI (and the case's argv log) instead of the fixture value. Same for the two switches
# README tells developers to keep in settings.json → "env" (which Claude Code exports to the Bash
# tool): FND_GQL_PROBE_CACHE=0 turns the probe-cache cases red, and an ambient TOML_PATH re-targets
# every case that relies on the repo fixture toml.
unset FND_MCP_SLIM_DEBUG FND_MCP_SLIM_DIR SHOPIFY_CLI_THEME_TOKEN SHOPIFY_STORE \
      FND_GQL_PROBE_CACHE TOML_PATH

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
  # the runner's OTHER exit-3 credential refusal: a token that cannot be an admin token at all
  badtoken) echo "error=invalid_admin_token source=.env (not an Admin API access token)" >&2; exit 3 ;;
  # two concatenated envelopes: valid JSON documents, but not ONE envelope
  twodocs) for _ in 1 2; do
             printf '{"data":{"theme":{"id":"gid://shopify/OnlineStoreTheme/2","name":"Dev","role":"%s","files":{"nodes":[{"filename":"templates/product.json","updatedAt":"now","body":{"content":"{}"}}],"userErrors":[]}}}}\n' "${FAKE_ROLE:-DEVELOPMENT}"
           done; exit 0 ;;
  errenv)  big=$(printf 'p%.0s' $(seq 1 9000))
           printf '{"errors":[{"message":"boom"}],"data":{"theme":{"pad":"%s"}}}\n' "$big"; exit 0 ;;
  notjson) echo "<<<not json>>>"; exit 0 ;;
  denied)  printf '{"errors":[{"message":"ACCESS_DENIED: read_themes is required"}]}\n'; exit 0 ;;
  # valid JSON that is not an object: the errors probe cannot apply and the shape checks decide
  array)   printf '[1,2]\n'; exit 0 ;;
  scalar)  printf 'null\n'; exit 0 ;;
  # exit 0 with NO output — parses fine, yields no value
  empty)   exit 0 ;;
esac
Q=""
while [ $# -gt 0 ]; do case "$1" in --query) Q="$2"; shift 2 ;; *) shift ;; esac; done
role="${FAKE_ROLE:-DEVELOPMENT}"
if grep -q FndThemesList "$Q"; then
  printf '{"data":{"themes":{"nodes":[{"id":"gid://shopify/OnlineStoreTheme/1","name":"Live","role":"MAIN"},{"id":"gid://shopify/OnlineStoreTheme/2","name":"Dev","role":"DEVELOPMENT"}]}}}\n'
elif grep -q FndThemeFileGet "$Q"; then
  case "${FAKE_GET_MODE:-}" in
    notheme) printf '{"data":{"theme":null}}\n'; exit 0 ;;
    ue) printf '{"data":{"theme":{"id":"gid://shopify/OnlineStoreTheme/2","name":"Dev","role":"%s","files":{"nodes":[],"userErrors":[{"filename":"templates/product.json","code":"NOT_FOUND"}]}}}}\n' "$role"; exit 0 ;;
    nobody) printf '{"data":{"theme":{"id":"gid://shopify/OnlineStoreTheme/2","name":"Dev","role":"%s","files":{"nodes":[{"filename":"templates/product.json","updatedAt":"now","body":{}}],"userErrors":[]}}}}\n' "$role"; exit 0 ;;
  esac
  if [ -n "${FAKE_BODY_FILE:-}" ]; then
    jq -nc --arg role "$role" --rawfile b "$FAKE_BODY_FILE" \
      '{data:{theme:{id:"gid://shopify/OnlineStoreTheme/2",name:"Dev",role:$role,files:{nodes:[{filename:"templates/product.json",updatedAt:"now",body:{content:$b}}],userErrors:[]}}}}'
  elif [ -n "${FAKE_BIG:-}" ]; then
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
# TJ_CLI_LOG records argv + the token the script exported, so the toml-extractor cases can
# assert what actually reached the CLI (the token value is a fixture, never a real secret)
if [ -n "${TJ_CLI_LOG:-}" ]; then
  printf 'argv=%s\n' "$*" >> "$TJ_CLI_LOG"
  printf 'token=%s\n' "${SHOPIFY_CLI_THEME_TOKEN:-}" >> "$TJ_CLI_LOG"
fi
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

# T17 (bug): --strip-comments is JSON-aware. A `/*` inside a custom_css string plus a `*/`
# inside a LATER value used to delete every key between them and still emit valid JSON, so
# the `set --from` guard passed and the corrupted settings were uploaded.
BF="$TMP/strip"; mkdir -p "$BF"
printf '%s' '/* banner
   do not edit */
{ "current": {
  "logo_width": 120,
  "custom_css": ".hero{color:red} /* TODO finish",
  "keep_me_a": "a",
  "keep_me_b": "b",
  "aspect_note": "never 4:3 */ ok",
  "footer_text": "Free over $50" } }' > "$BF/corrupt.json"
rc=0; FAKE_BODY_FILE="$BF/corrupt.json" "$BASH_BIN" "$TJDIR/theme-json.sh" get --theme 2 \
  --file config/settings_data.json --strip-comments --out "$BF/stripped.json" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && jq empty "$BF/stripped.json" >/dev/null 2>&1 \
   && [ "$(jq -r '.current | keys_unsorted | length' "$BF/stripped.json" 2>/dev/null)" = 6 ] \
   && [ "$(jq -r '.current.custom_css' "$BF/stripped.json" 2>/dev/null)" = '.hero{color:red} /* TODO finish' ] \
   && [ "$(jq -r '.current.aspect_note' "$BF/stripped.json" 2>/dev/null)" = 'never 4:3 */ ok' ] \
   && ! grep -q 'do not edit' "$BF/stripped.json"; then ok
else bad T17-strip-json-aware "rc=$rc keys=$(jq -r '.current|keys_unsorted|join(",")' "$BF/stripped.json" 2>/dev/null) css=$(jq -r '.current.custom_css' "$BF/stripped.json" 2>/dev/null)"; fi

# T17b: the milder always-on case — a BALANCED css comment inside a string value is content,
# not a banner; only comments outside strings may go
printf '%s' '/* banner */
{"current":{"custom_css":".x{} /* agency override — do not remove */ .y{}"}}' > "$BF/inline.json"
rc=0; FAKE_BODY_FILE="$BF/inline.json" "$BASH_BIN" "$TJDIR/theme-json.sh" get --theme 2 \
  --file config/settings_data.json --strip-comments --out "$BF/inline.out" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ "$(jq -r '.current.custom_css' "$BF/inline.out" 2>/dev/null)" = '.x{} /* agency override — do not remove */ .y{}' ] \
   && [ "$(head -c 1 "$BF/inline.out")" = '{' ]; then ok
else bad T17b-strip-keeps-inline-comment "rc=$rc css=$(jq -r '.current.custom_css' "$BF/inline.out" 2>/dev/null)"; fi

# T18 (bug): the `set --from` json guard strips comments the same JSON-aware way — a file that
# only LOOKS valid after a naive /*…*/ removal must still be refused before any upload
printf '%s' '{"a":"/* oops","bogus" ,,, "b":"*/","c":1}' > "$BF/fake-valid.json"
rc=0; "$BASH_BIN" "$TJDIR/theme-json.sh" set --theme 2 --file templates/product.json \
  --from "$BF/fake-valid.json" >"$O" 2>"$E" || rc=$?
assert T18-from-guard-json-aware 2 "$rc" "$E" "error=from_file_invalid_json"

# T18b (pin): a genuinely banner-commented body is still accepted by that guard
printf '%s' '/* auto-generated */
{"current":{"a":1}}' > "$BF/bannered.json"
rc=0; "$BASH_BIN" "$TJDIR/theme-json.sh" set --theme 2 --file templates/product.json \
  --from "$BF/bannered.json" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -q '"ok":"upserted"' "$O"; then ok; else bad T18b-banner-accepted "rc=$rc err=$(head -c 150 "$E" | tr '\n' ' ')"; fi

# --- toml scalar extraction (bug): single-quoted / bare / commented values ----------------
TT="$TMP/tjtoml"; mkdir -p "$TT"
# T19: a single-quoted store= used to reach the CLI as `store = 'x'` (whole line)
printf "[environments.development]\nstore = 'acme-dev'\npassword = 'shptka_fixture1234'\n" > "$TT/single.toml"
rc=0; L="$TMP/tjl19"; : > "$L"
TOML_PATH="$TT/single.toml" TJ_CLI_LOG="$L" PATH="$TJSHIM:$PATH" \
  "$BASH_BIN" "$TJDIR/theme-json.sh" themes --engine themecli >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -q 'argv=.*--store acme-dev\.myshopify\.com ' "$L"; then ok
else bad T19-toml-single-quoted-store "rc=$rc log=$(tr '\n' ';' < "$L") err=$(head -c 120 "$E" | tr '\n' ' ')"; fi

# T20: the same line shape for password= used to export the whole line as the Theme Access token,
# which also skipped the shp*_ fallback
if grep -q 'token=shptka_fixture1234$' "$L"; then ok; else bad T20-toml-single-quoted-token "log=$(tr '\n' ';' < "$L")"; fi

# T21: a bare value with a trailing comment
printf '[environments.development]\nstore = acme-bare.myshopify.com   # legacy\npassword = "shptka_fixture1234"\n' > "$TT/bare.toml"
rc=0; L="$TMP/tjl21"; : > "$L"
TOML_PATH="$TT/bare.toml" TJ_CLI_LOG="$L" PATH="$TJSHIM:$PATH" \
  "$BASH_BIN" "$TJDIR/theme-json.sh" themes --engine themecli >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -q 'argv=.*--store acme-bare\.myshopify\.com ' "$L"; then ok
else bad T21-toml-bare-store "rc=$rc log=$(tr '\n' ';' < "$L")"; fi

# T22 (bug): a store value that cannot be a shop handle fails loudly instead of being handed
# to the CLI (a garbage --store is an opaque CLI error at best, the wrong store at worst)
printf '[environments.development]\nstore = acme dev\npassword = "shptka_fixture1234"\n' > "$TT/broken.toml"
rc=0; L="$TMP/tjl22"; : > "$L"
TOML_PATH="$TT/broken.toml" TJ_CLI_LOG="$L" PATH="$TJSHIM:$PATH" \
  "$BASH_BIN" "$TJDIR/theme-json.sh" themes --engine themecli >"$O" 2>"$E" || rc=$?
assert T22-bad-store-refused 2 "$rc" "$E" "error=invalid_store"
if [ ! -s "$L" ]; then ok; else bad T22b-no-cli-call "the CLI ran with a garbage store :: $(tr '\n' ';' < "$L")"; fi

# --- envelope status pass (F7 pin): one jq pass, identical messages and ORDER --------------
# T23: theme missing
rc=0; FAKE_GET_MODE=notheme "$BASH_BIN" "$TJDIR/theme-json.sh" get --theme 2 \
  --file templates/product.json >"$O" 2>"$E" || rc=$?
assert T23-theme-not-found 5 "$rc" "$E" "error=theme_not_found theme=gid://shopify/OnlineStoreTheme/2"

# T24: file userErrors win over the missing body, and the compact array is echoed verbatim
rc=0; FAKE_GET_MODE=ue "$BASH_BIN" "$TJDIR/theme-json.sh" get --theme 2 \
  --file templates/product.json >"$O" 2>"$E" || rc=$?
assert T24-file-user-errors 5 "$rc" "$E" "error=file_user_errors file=templates/product.json"
if grep -qF 'file=templates/product.json [{"filename":"templates/product.json","code":"NOT_FOUND"}]' "$E"; then ok
else bad T24b-ue-array-verbatim "err=$(head -c 200 "$E" | tr '\n' ' ')"; fi

# T25: no text body
rc=0; FAKE_GET_MODE=nobody "$BASH_BIN" "$TJDIR/theme-json.sh" get --theme 2 \
  --file templates/product.json >"$O" 2>"$E" || rc=$?
assert T25-no-text-body 5 "$rc" "$E" "error=file_not_found_or_not_text file=templates/product.json theme=gid://shopify/OnlineStoreTheme/2"

# T26 (pin): a VALID but non-object envelope is not a json error — the errors probe cannot
# apply to it and the shape check reports theme_not_found (pre-existing behavior). The merged
# probe short-circuits on the type instead of letting jq print a raw diagnostic first.
rc=0; FAKE_RUNNER_MODE=array "$BASH_BIN" "$TJDIR/theme-json.sh" get --theme 2 \
  --file templates/product.json >"$O" 2>"$E" || rc=$?
assert T26-non-object-envelope 5 "$rc" "$E" "error=theme_not_found"
if ! grep -q 'jq: error' "$E"; then ok; else bad T26b-no-jq-noise "err=$(head -c 160 "$E" | tr '\n' ' ')"; fi

# T26c (pin): a scalar envelope takes the same fall-through
rc=0; FAKE_RUNNER_MODE=scalar "$BASH_BIN" "$TJDIR/theme-json.sh" get --theme 2 \
  --file templates/product.json >"$O" 2>"$E" || rc=$?
assert T26c-scalar-envelope 5 "$rc" "$E" "error=theme_not_found"

# T26e (pin): a response that PARSES but yields no value at all is not non_json_response —
# the merged probe keys "not JSON" on jq's exit status, not on its (absent) output
rc=0; FAKE_RUNNER_MODE=empty "$BASH_BIN" "$TJDIR/theme-json.sh" get --theme 2 \
  --file templates/product.json >"$O" 2>"$E" || rc=$?
assert T26e-empty-envelope 5 "$rc" "$E" "error=theme_not_found"
if ! grep -q 'error=non_json_response' "$E"; then ok; else bad T26f-empty-not-nonjson "err=$(head -c 160 "$E" | tr '\n' ' ')"; fi

# T27 (pin): the errors check must stay ABLE to hand control back — an ACCESS_DENIED envelope
# in auto mode falls back to themecli, it does not exit
rc=0; M27="$TMP/tj27"; TJ_CLI_MARKER="$M27" FAKE_RUNNER_MODE=denied SHOPIFY_CLI_THEME_TOKEN=fake \
  PATH="$TJSHIM:$PATH" "$BASH_BIN" "$TJDIR/theme-json.sh" themes --store test.myshopify.com >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ -f "$M27" ] && grep -q 'lacks read_themes' "$E"; then ok
else bad T27-denied-fallback "rc=$rc err=$(head -c 160 "$E" | tr '\n' ' ')"; fi

# T27b (pin): the same envelope with no Theme Access token available reports the scope hint
rc=0; FAKE_RUNNER_MODE=denied "$BASH_BIN" "$TJDIR/theme-json.sh" themes >"$O" 2>"$E" || rc=$?
assert T27b-denied-no-token 5 "$rc" "$E" "error=gql_errors"
if grep -q 'hint=the credential lacks read_themes' "$E"; then ok; else bad T27c-scope-hint "err=$(head -c 200 "$E" | tr '\n' ' ')"; fi

# T28 (bug): the merged status pass prints one line PER DOCUMENT, so a response carrying two
# envelopes is not one envelope — every check downstream would read the first document's answer
# glued to the rest, including `set`'s live-theme refusal (`.data.theme.role` stops matching MAIN)
rc=0; FAKE_RUNNER_MODE=twodocs "$BASH_BIN" "$TJDIR/theme-json.sh" get --theme 2 \
  --file templates/product.json >"$O" 2>"$E" || rc=$?
assert T28-multi-document 5 "$rc" "$E" "error=non_json_response"
rc=0; M28="$TMP/tj28"; TJ_CLI_MARKER="$M28" FAKE_RUNNER_MODE=twodocs FAKE_ROLE=MAIN \
  PATH="$TJSHIM:$PATH" "$BASH_BIN" "$TJDIR/theme-json.sh" set --theme 2 --file templates/product.json \
  --from "$TMP/snap.json" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 5 ] && [ ! -f "$M28" ]; then ok
else bad T28b-multi-document-no-write "rc=$rc cli-invoked=$([ -f "$M28" ] && echo yes || echo no)"; fi

# T29 (contract): theme-json decides its themecli fallback by grepping the runner's stderr for
# `error=no_admin_token`. The runner's OTHER credential refusal (a token that cannot be one) must
# stay a hard stop — renaming it to no_admin_token would silently swap engines on a typo'd token.
rc=0; M29="$TMP/tj29"; TJ_CLI_MARKER="$M29" FAKE_RUNNER_MODE=badtoken SHOPIFY_CLI_THEME_TOKEN=fake \
  PATH="$TJSHIM:$PATH" "$BASH_BIN" "$TJDIR/theme-json.sh" themes --store test.myshopify.com >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 3 ] && [ ! -f "$M29" ] && grep -q 'error=invalid_admin_token' "$E"; then ok
else bad T29-invalid-token-no-cli-fallback "rc=$rc cli-invoked=$([ -f "$M29" ] && echo yes || echo no) err=$(head -c 160 "$E" | tr '\n' ' ')"; fi

# T30 (bug): `shopify --store` documents the https:// URL form as valid — it is normalized, not
# refused, and the CLI sees the bare domain
rc=0; L="$TMP/tjl30"; : > "$L"
TOML_PATH="$TT/single.toml" TJ_CLI_LOG="$L" PATH="$TJSHIM:$PATH" \
  "$BASH_BIN" "$TJDIR/theme-json.sh" themes --engine themecli --store "https://acme-dev.myshopify.com" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -q 'argv=.*--store acme-dev\.myshopify\.com ' "$L"; then ok
else bad T30-store-url-form "rc=$rc log=$(tr '\n' ';' < "$L") err=$(head -c 120 "$E" | tr '\n' ' ')"; fi

# T31 (drift guard): the toml scalar reader is copied byte-for-byte into three scripts because the
# plugin installs by git clone and each must stand alone — an edit to one copy would make them
# disagree about which store/theme/token a toml resolves to, which is the class of bug they fix
tv_a="$TMP/tv-a"; tv_b="$TMP/tv-b"; tv_c="$TMP/tv-c"
awk '/^toml_value\(\) \{/,/^\}/' "$TJ" > "$tv_a"
awk '/^toml_value\(\) \{/,/^\}/' "$CPT" > "$tv_b"
awk '/^toml_value\(\) \{/,/^\}/' "$GQL" > "$tv_c"
if [ -s "$tv_a" ] && cmp -s "$tv_a" "$tv_b" && cmp -s "$tv_a" "$tv_c"; then ok
else bad T31-toml-reader-in-sync "the three toml_value copies have drifted apart"; fi

# T32 (pin): --strip-comments removes bytes and appends none — the stripped body is the base a jq
# edit and then `set --from` upload, so a trailing newline would be a byte the theme did not have
printf '%s' '/* b */{"current":{"a":1}}' > "$BF/nonl.json"
rc=0; FAKE_BODY_FILE="$BF/nonl.json" "$BASH_BIN" "$TJDIR/theme-json.sh" get --theme 2 \
  --file config/settings_data.json --strip-comments --out "$BF/nonl.out" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ "$(cat "$BF/nonl.out")" = '{"current":{"a":1}}' ] \
   && [ "$(wc -c < "$BF/nonl.out" | tr -d ' ')" -eq 19 ]; then ok
else bad T32-strip-appends-nothing "rc=$rc bytes=$(wc -c < "$BF/nonl.out" | tr -d ' ') body=$(cat "$BF/nonl.out")"; fi

# T33 (bug): a toml that EXISTS but cannot be opened (mode 000 — a shared checkout, another uid)
# degrades to error=no_store like an absent file, never a bare awk error with no error= line —
# the `|| true` on the toml_value call site is what keeps set -euo pipefail out of it
UT33="$TMP/unreadable-t.toml"; printf 'store = "acme-dev"\n' > "$UT33"; chmod 000 "$UT33"
rc=0; TOML_PATH="$UT33" "$BASH_BIN" "$TJ" themes --engine themecli >"$O" 2>"$E" || rc=$?
chmod 644 "$UT33"
if [ "$rc" -eq 2 ] && grep -q 'error=no_store' "$E" && ! grep -qi "awk: can't open" "$E"; then ok
else bad T33-unreadable-toml-no-store "rc=$rc err=$(head -c 160 "$E" | tr '\n' ' ')"; fi

# ------------------------------------- shopify-admin-gql.sh against PATH shims --
SHIM="$TMP/shim"; mkdir -p "$SHIM"
GQLDIR="$TMP/gqlwork"; mkdir -p "$GQLDIR"
printf 'mutation FndX { thingCreate { id } }\n' > "$GQLDIR/mutation.graphql"
printf 'query FndY { shop { name } }\n' > "$GQLDIR/query.graphql"
printf '{"k":"v"}\n' > "$GQLDIR/vars.json"

cat > "$SHIM/shopify" <<'FAKE'
#!/usr/bin/env bash
# $SHOPIFY_LOG counts invocations (one argv line each) — the only way to assert that the
# version probe and the doomed `store execute` were NOT paid a second time.
[ -n "${SHOPIFY_LOG:-}" ] && printf '%s\n' "$*" >> "$SHOPIFY_LOG"
# FAKE_VERSION set-but-EMPTY is its own fixture (a CLI that prints nothing), so the default only
# applies when the variable is unset
if [ "${1:-}" = "version" ]; then echo "${FAKE_VERSION-4.5.2}"; exit 0; fi
case "${FAKE_EXEC_MODE:-garbage}" in
  garbage) echo "unexpected CLI crash output" >&2; exit 1 ;;
  noauth)  echo "No stored app authentication found" >&2; exit 1 ;;
  ok)      echo '{"ok":true}'; exit 0 ;;
esac
FAKE
cat > "$SHIM/curl" <<'FAKE'
#!/usr/bin/env bash
# emulates the exact flags the runner uses: -o <file>, -w '%{http_code}', --data @file, -K <cfg>
touch "${CURL_MARKER:-/dev/null}"
out=""; data=""; cfg=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -w) shift 2 ;;
    --data) data="$2"; shift 2 ;;
    -K) cfg="$2"; shift 2 ;;
    -H|-X) shift 2 ;;
    *) shift ;;
  esac
done
case "$data" in @*) cp "${data#@}" "${CURL_MARKER:-/dev/null}.body" 2>/dev/null || true ;; esac
# the token rides a private config file, never the argv — copy it out so a case can assert the
# header line is exactly the token (a stray comment/CR/quote there is the opaque-401 bug)
[ -n "$cfg" ] && cp "$cfg" "${CURL_MARKER:-/dev/null}.hdr" 2>/dev/null || true
body="${FAKE_HTTP_BODY:-}"; [ -n "$body" ] || body='{"data":{"ok":true}}'
printf '%s' "$body" > "${out:-/dev/null}"
printf '%s' "${FAKE_HTTP:-200}"
FAKE
chmod +x "$SHIM/shopify" "$SHIM/curl"

GQL_RUNS=0
gql_run_at() { # gql_run_at <cwd> <args…> — no implicit --store (store-resolution cases)
  # TMPDIR is pinned to a FRESH dir per call: the runner's state dir (fallback note, store-engine
  # skip mark, CLI-version cache) lives under it, and an ambient TMPDIR would carry that state
  # across cases and across suite runs — G1 only proves anything while an execute is still tried.
  # Cases that need shared state pass GQL_TMPDIR; GQL_LOG collects the shopify argv log,
  # GQL_TOKEN="" drops the env token so the --env file is read. All three are one-shot
  # (bash restores an assignment prefix when the function returns).
  GQL_RUNS=$((GQL_RUNS + 1))
  local cwd="$1"; shift
  local td="${GQL_TMPDIR:-}"
  if [ -z "$td" ]; then td="$TMP/gqltmp-$GQL_RUNS"; mkdir -p "$td"; fi
  (cd "$cwd" && PATH="$SHIM:$PATH" TMPDIR="$td" SHOPIFY_LOG="${GQL_LOG:-/dev/null}" \
     SHOPIFY_ADMIN_TOKEN="${GQL_TOKEN-test-token}" "$BASH_BIN" "$GQL" "$@")
}
run_gql() { # runs the real script with shims; args pass through
  gql_run_at "$GQLDIR" --store test-store "$@"
}
gql_state() { printf '%s/fnd-gql-%s' "$1" "$(id -u)"; }   # the runner's per-user state dir

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
rc=0; GQL_TMPDIR="$QT" run_gql --query query.graphql >"$O" 2>"$E" || rc=$?
assert G11-first-run-full 0 "$rc" "$E" "store_execute unavailable"
rc=0; GQL_TMPDIR="$QT" run_gql --query query.graphql >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -q 'note=engine=token' "$E" && ! grep -q 'store_execute unavailable' "$E"; then ok
else bad G11b-second-run-short "err=$(head -c 200 "$E" | tr '\n' ' ')"; fi

# G12: SHOPIFY_ADMIN_GQL_QUIET forces the short note even on a first run
QT2="$TMP/quiet-tmpdir2"; mkdir -p "$QT2"
rc=0; GQL_TMPDIR="$QT2" SHOPIFY_ADMIN_GQL_QUIET=1 run_gql --query query.graphql >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -q 'note=engine=token' "$E" && ! grep -q 'store_execute unavailable' "$E"; then ok
else bad G12-quiet-env "err=$(head -c 200 "$E" | tr '\n' ' ')"; fi

# G12b: QUIET=0 means OFF — the first-run full note (with the store-auth remediation) prints
QT3="$TMP/quiet-tmpdir3"; mkdir -p "$QT3"
rc=0; GQL_TMPDIR="$QT3" SHOPIFY_ADMIN_GQL_QUIET=0 run_gql --query query.graphql >"$O" 2>"$E" || rc=$?
assert G12b-quiet-zero-off 0 "$rc" "$E" "store_execute unavailable"

# G13: --out pointing at an existing directory is a clean hard stop, not a stray cp + wc abort
mkdir -p "$TMP/outdir"
rc=0; run_gql --engine token --query query.graphql --out "$TMP/outdir" >"$O" 2>"$E" || rc=$?
assert G13-out-is-dir 5 "$rc" "$E" "error=out_write_failed"

# ---- 2026-07 deep review: dotenv token hygiene, private state dir, probe caching ----

ENVD="$TMP/gqlenv"; mkdir -p "$ENVD"
printf 'OTHER=1\nSHOPIFY_ADMIN_TOKEN=shpat_clean123 # prod admin api, read_themes\n' > "$ENVD/comment.env"
printf 'SHOPIFY_ADMIN_TOKEN="shpat_clean123"\r\n' > "$ENVD/crlf.env"
printf 'export SHOPIFY_ADMIN_TOKEN="shpat_clean123"\n' > "$ENVD/export.env"
printf 'SHOPIFY_ADMIN_TOKEN=notatoken\n' > "$ENVD/shape.env"
printf '# SHOPIFY_ADMIN_TOKEN=shpat_commented\nSHOPIFY_ADMIN_TOKEN=shpat_first\nSHOPIFY_ADMIN_TOKEN=shpat_last\n' > "$ENVD/dupe.env"
# the token reaches curl only through the private config file — assert on that exact line
hdr_is() { grep -qx "header = \"X-Shopify-Access-Token: $1\"" "$2" 2>/dev/null; }

# G14 (bug): a trailing dotenv comment rode into the auth header and came back as an opaque 401
rc=0; M="$TMP/m14"; CURL_MARKER="$M" GQL_TOKEN="" \
  run_gql --engine token --query query.graphql --env "$ENVD/comment.env" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && hdr_is shpat_clean123 "$M.hdr"; then ok
else bad G14-token-inline-comment "rc=$rc hdr=$(head -c 160 "$M.hdr" 2>/dev/null)"; fi

# G15 (bug): a CRLF file defeated `s/"$//`, so the CR *and* the closing quote reached the header
rc=0; M="$TMP/m15"; CURL_MARKER="$M" GQL_TOKEN="" \
  run_gql --engine token --query query.graphql --env "$ENVD/crlf.env" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && hdr_is shpat_clean123 "$M.hdr"; then ok
else bad G15-token-crlf-quoted "rc=$rc hdr=$(od -c "$M.hdr" 2>/dev/null | head -2 | tr '\n' ' ')"; fi

# G16 (bug): `export KEY=` is a legal dotenv line the anchored matcher missed entirely
rc=0; M="$TMP/m16"; CURL_MARKER="$M" GQL_TOKEN="" \
  run_gql --engine token --query query.graphql --env "$ENVD/export.env" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && hdr_is shpat_clean123 "$M.hdr"; then ok
else bad G16-token-export-prefix "rc=$rc err=$(head -c 160 "$E" | tr '\n' ' ')"; fi

# G17: a dotenv value that is not shpat_/shpca_ fails loudly instead of buying a 401 round trip
rc=0; M="$TMP/m17"; CURL_MARKER="$M" GQL_TOKEN="" \
  run_gql --engine token --query query.graphql --env "$ENVD/shape.env" >"$O" 2>"$E" || rc=$?
assert G17-token-bad-shape 3 "$rc" "$E" "error=invalid_admin_token"
if [ ! -f "$M" ]; then ok; else bad G17b-no-request "a malformed token still hit the network"; fi

# G18: $SHOPIFY_ADMIN_TOKEN stays the escape hatch — no shape gate on an explicit export
rc=0; M="$TMP/m18"; CURL_MARKER="$M" \
  run_gql --engine token --query query.graphql >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && hdr_is test-token "$M.hdr"; then ok
else bad G18-env-token-escape-hatch "rc=$rc hdr=$(head -c 160 "$M.hdr" 2>/dev/null)"; fi

# G18b: a newline in the token would inject a second curl directive — refused before curl runs
rc=0; M="$TMP/m18b"; CURL_MARKER="$M" GQL_TOKEN="$(printf 'shpat_x\nheader = "X-Evil: 1"')" \
  run_gql --engine token --query query.graphql >"$O" 2>"$E" || rc=$?
assert G18b-token-injection-refused 3 "$rc" "$E" "error=invalid_admin_token"
if [ ! -f "$M" ]; then ok; else bad G18c-injection-no-request "curl ran with an injected config"; fi

# G18d: last assignment wins, a commented-out line never does
rc=0; M="$TMP/m18d"; CURL_MARKER="$M" GQL_TOKEN="" \
  run_gql --engine token --query query.graphql --env "$ENVD/dupe.env" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && hdr_is shpat_last "$M.hdr"; then ok
else bad G18d-token-last-wins "rc=$rc hdr=$(head -c 160 "$M.hdr" 2>/dev/null)"; fi

# G19 (bug): the marker is a guessable path in a shared /tmp — state moves into a 0700 per-user dir
QT4="$TMP/state-tmpdir"; mkdir -p "$QT4"
rc=0; GQL_TMPDIR="$QT4" run_gql --query query.graphql >"$O" 2>"$E" || rc=$?
SD="$(gql_state "$QT4")"
if [ "$rc" -eq 0 ] && [ -d "$SD" ] && [ "$(ls -ld "$SD" | cut -c1-10)" = "drwx------" ]; then ok
else bad G19-state-dir-0700 "rc=$rc mode=$(ls -ld "$SD" 2>&1 | cut -c1-10)"; fi
stray="$(find "$QT4" -maxdepth 1 -type f 2>/dev/null | head -3)"
if [ -z "$stray" ]; then ok; else bad G19b-no-flat-marker "loose state in TMPDIR: $stray"; fi

# G20: a DANGLING symlink at the state-dir path — pins the weaker half only: no write lands through
# the link and the run still succeeds uncached rather than dying (on BSD `mkdir -p` fails on the
# dangling target before the guard is even consulted; G36's existing-dir variant exercises the guard)
QT5="$TMP/state-symlink"; mkdir -p "$QT5"
ln -s "$TMP/evil-target" "$(gql_state "$QT5")"
rc=0; GQL_TMPDIR="$QT5" run_gql --query query.graphql >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -q '"ok":true' "$O" && [ ! -e "$TMP/evil-target" ]; then ok
else bad G20-symlinked-state-dir "rc=$rc target=$([ -e "$TMP/evil-target" ] && echo created || echo absent)"; fi

# G21 (perf pin): once the store engine is known-unavailable here via a STICKY verdict (no stored
# store auth — an unrecognized execute crash is NOT sticky, see G40), the second call skips the
# whole probe (`shopify version` ~1.5 s + a doomed `store execute`) with byte-identical output
QT6="$TMP/probe-tmpdir"; mkdir -p "$QT6"; L1="$TMP/sl1"; L2="$TMP/sl2"; : > "$L1"; : > "$L2"
cold_rc=0; GQL_TMPDIR="$QT6" GQL_LOG="$L1" FAKE_EXEC_MODE=noauth run_gql --query query.graphql >"$TMP/cold.out" 2>"$E" || cold_rc=$?
rc=0; GQL_TMPDIR="$QT6" GQL_LOG="$L2" FAKE_EXEC_MODE=noauth run_gql --query query.graphql >"$TMP/warm.out" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ "$cold_rc" -eq 0 ] && cmp -s "$TMP/cold.out" "$TMP/warm.out"; then ok
else bad G21-warm-cache-same-output "cold_rc=$cold_rc warm_rc=$rc"; fi
if [ "$(grep -c . "$L1")" -eq 2 ] && [ "$(grep -c . "$L2")" -eq 0 ]; then ok
else bad G21b-warm-cache-no-probe "cold=[$(tr '\n' ';' < "$L1")] warm=[$(tr '\n' ';' < "$L2")]"; fi

# G22: --engine store must ignore the skip mark (still attempt + report) while reusing the
# cached version probe
QT7="$TMP/probe-store"; mkdir -p "$QT7"
rc=0; GQL_TMPDIR="$QT7" run_gql --query query.graphql >"$O" 2>"$E" || rc=$?
L4="$TMP/sl4"; : > "$L4"
rc=0; GQL_TMPDIR="$QT7" GQL_LOG="$L4" run_gql --engine store --query query.graphql >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 3 ] && grep -q 'error=store_execute_failed ' "$E" \
   && [ "$(grep -c 'store execute' "$L4")" -eq 1 ] && [ "$(grep -c '^version' "$L4")" -eq 0 ]; then ok
else bad G22-engine-store-ignores-skip "rc=$rc err=$(head -c 120 "$E" | tr '\n' ' ') calls=[$(tr '\n' ';' < "$L4")]"; fi

# G23: a CLI upgraded in place (binary newer than the cache) re-probes the version
QT8="$TMP/probe-stale"; mkdir -p "$QT8"
rc=0; GQL_TMPDIR="$QT8" run_gql --engine store --query query.graphql >"$O" 2>"$E" || rc=$?
touch -t 203001010101 "$SHIM/shopify"
L5="$TMP/sl5"; : > "$L5"
rc=0; GQL_TMPDIR="$QT8" GQL_LOG="$L5" run_gql --engine store --query query.graphql >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 3 ] && [ "$(grep -c '^version' "$L5")" -eq 1 ]; then ok
else bad G23-stale-cache-reprobes "rc=$rc calls=[$(tr '\n' ';' < "$L5")]"; fi
touch "$SHIM/shopify"

# G24: FND_GQL_PROBE_CACHE=0 is the escape hatch — warm state is ignored, everything is re-probed
QT9="$TMP/probe-off"; mkdir -p "$QT9"
rc=0; GQL_TMPDIR="$QT9" run_gql --query query.graphql >"$O" 2>"$E" || rc=$?
L6="$TMP/sl6"; : > "$L6"
rc=0; GQL_TMPDIR="$QT9" GQL_LOG="$L6" FND_GQL_PROBE_CACHE=0 \
  run_gql --query query.graphql >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ "$(grep -c '^version' "$L6")" -eq 1 ] && [ "$(grep -c 'store execute' "$L6")" -eq 1 ]; then ok
else bad G24-cache-disabled "rc=$rc calls=[$(tr '\n' ';' < "$L6")]"; fi

# G24b: an expired window re-probes; a corrupt state file is treated as absent, never as fatal
QT9b="$TMP/probe-expired"; mkdir -p "$QT9b"
rc=0; GQL_TMPDIR="$QT9b" run_gql --query query.graphql >"$O" 2>"$E" || rc=$?
SD9="$(gql_state "$QT9b")"
printf '1\nstale reason\n' > "$SD9/store-skip-test-store.myshopify.com"   # epoch 1970
printf '1 4.5.2\n%s\n' "$SHIM/shopify" > "$SD9/cli-version"
L6b="$TMP/sl6b"; : > "$L6b"
rc=0; GQL_TMPDIR="$QT9b" GQL_LOG="$L6b" run_gql --query query.graphql >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ "$(grep -c '^version' "$L6b")" -eq 1 ] && [ "$(grep -c 'store execute' "$L6b")" -eq 1 ]; then ok
else bad G24b-ttl-expiry-reprobes "rc=$rc calls=[$(tr '\n' ';' < "$L6b")]"; fi
printf 'not-a-timestamp\n' > "$SD9/store-skip-test-store.myshopify.com"
printf 'garbage\n' > "$SD9/cli-version"
L6c="$TMP/sl6c"; : > "$L6c"
rc=0; GQL_TMPDIR="$QT9b" GQL_LOG="$L6c" run_gql --query query.graphql >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -q '"ok":true' "$O" && [ "$(grep -c '^version' "$L6c")" -eq 1 ]; then ok
else bad G24c-corrupt-state-ignored "rc=$rc out=$(head -c 80 "$O") calls=[$(tr '\n' ';' < "$L6c")]"; fi

# G25: a mutation whose execute was SKIPPED (never attempted) may fall back — the
# double-execution hazard of G1 only exists for an execute that actually ran. The mark comes
# from a sticky no-stored-auth verdict (an unrecognized crash writes no mark, G40)
QT10="$TMP/probe-mutation"; mkdir -p "$QT10"
rc=0; GQL_TMPDIR="$QT10" FAKE_EXEC_MODE=noauth run_gql --query query.graphql >"$O" 2>"$E" || rc=$?
M="$TMP/m25"; L7="$TMP/sl7"; : > "$L7"
rc=0; GQL_TMPDIR="$QT10" GQL_LOG="$L7" CURL_MARKER="$M" \
  run_gql --query mutation.graphql >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -q '"ok":true' "$O" && [ -f "$M" ] \
   && [ "$(grep -c 'store execute' "$L7")" -eq 0 ]; then ok
else bad G25-skipped-mutation-falls-back "rc=$rc out=$(head -c 80 "$O") calls=[$(tr '\n' ';' < "$L7")]"; fi

# G26: the skip mark carries the original reason, so a first full note still explains itself
# even when the probe was skipped
QT11="$TMP/probe-reason"; mkdir -p "$QT11"
rc=0; GQL_TMPDIR="$QT11" FAKE_EXEC_MODE=noauth run_gql --query query.graphql >"$O" 2>"$E" || rc=$?
rm -f "$(gql_state "$QT11")"/note-*
L8="$TMP/sl8"; : > "$L8"
rc=0; GQL_TMPDIR="$QT11" GQL_LOG="$L8" run_gql --query query.graphql >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -q 'store_execute unavailable' "$E" \
   && grep -q 'no stored store auth' "$E" && [ "$(grep -c . "$L8")" -eq 0 ]; then ok
else bad G26-cached-reason-in-note "rc=$rc err=$(head -c 200 "$E" | tr '\n' ' ')"; fi

# G27 (pin): caching must not change the unparseable-version verdict, warm or cold
QT12="$TMP/probe-badver"; mkdir -p "$QT12"
rc=0; GQL_TMPDIR="$QT12" FAKE_VERSION=banana \
  run_gql --engine store --query query.graphql >"$O" 2>"$TMP/e27a" || rc=$?
a_rc=$rc; L9="$TMP/sl9"; : > "$L9"
rc=0; GQL_TMPDIR="$QT12" GQL_LOG="$L9" FAKE_VERSION=banana \
  run_gql --engine store --query query.graphql >"$O" 2>"$TMP/e27b" || rc=$?
if [ "$a_rc" -eq 3 ] && [ "$rc" -eq 3 ] && cmp -s "$TMP/e27a" "$TMP/e27b" \
   && grep -q "unparseable shopify CLI version 'banana'" "$TMP/e27b" \
   && [ "$(grep -c '^version' "$L9")" -eq 0 ]; then ok
else bad G27-unparseable-version-cached "a_rc=$a_rc b_rc=$rc err=$(head -c 160 "$TMP/e27b" | tr '\n' ' ')"; fi

# G28 (bug): a single-quoted store= in the toml became the literal domain `'acme-dev'.myshopify.com`
TD1="$TMP/gqltoml1"; mkdir -p "$TD1"; cp "$GQLDIR/query.graphql" "$TD1/"
printf "[environments.development]\nstore = 'acme-dev'\n" > "$TD1/shopify.theme.toml"
rc=0; FAKE_HTTP=401 gql_run_at "$TD1" --engine token --query query.graphql >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 5 ] && grep -q 'url=https://acme-dev.myshopify.com/admin/' "$E"; then ok
else bad G28-toml-single-quoted-store "rc=$rc err=$(head -c 160 "$E" | tr '\n' ' ')"; fi

# G29 (pin): bare and double-quoted values keep working, trailing comment dropped either way
TD2="$TMP/gqltoml2"; mkdir -p "$TD2"; cp "$GQLDIR/query.graphql" "$TD2/"
printf '[environments.development]\nstore = acme-dev.myshopify.com   # was "acme-legacy"\n' > "$TD2/shopify.theme.toml"
rc=0; FAKE_HTTP=401 gql_run_at "$TD2" --engine token --query query.graphql >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 5 ] && grep -q 'url=https://acme-dev.myshopify.com/admin/' "$E"; then ok
else bad G29-toml-bare-store "rc=$rc err=$(head -c 160 "$E" | tr '\n' ' ')"; fi
printf '[environments.development]\nstore = "acme-dev"  # keep\n' > "$TD2/shopify.theme.toml"
rc=0; FAKE_HTTP=401 gql_run_at "$TD2" --engine token --query query.graphql >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 5 ] && grep -q 'url=https://acme-dev.myshopify.com/admin/' "$E"; then ok
else bad G29b-toml-quoted-store "rc=$rc err=$(head -c 160 "$E" | tr '\n' ' ')"; fi

# G30: a store value that cannot be a myshopify handle is refused before any request
rc=0; M="$TMP/m30"; CURL_MARKER="$M" \
  gql_run_at "$GQLDIR" --engine token --store "store = 'x'" --query query.graphql >"$O" 2>"$E" || rc=$?
assert G30-bad-store-refused 2 "$rc" "$E" "error=invalid_store"
if [ ! -f "$M" ]; then ok; else bad G30b-no-request "a garbage store still hit the network"; fi

# G31 (bug): `shopify --store` documents the https:// URL form as valid, and real tomls carry it —
# the handle gate must normalize it, not refuse a supported config
rc=0; gql_run_at "$GQLDIR" --engine token --store "https://acme-dev.myshopify.com/" \
  --query query.graphql >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -q '"ok":true' "$O"; then ok
else bad G31-store-url-form "rc=$rc err=$(head -c 160 "$E" | tr '\n' ' ')"; fi
rc=0; FAKE_HTTP=401 gql_run_at "$GQLDIR" --engine token --store "https://acme-dev.myshopify.com" \
  --query query.graphql >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 5 ] && grep -q 'url=https://acme-dev.myshopify.com/admin/' "$E"; then ok
else bad G31b-store-url-domain "rc=$rc err=$(head -c 160 "$E" | tr '\n' ' ')"; fi

# G32 (bug): the skip mark records a MACHINE verdict. A per-CALL skip — here an oversized variables
# payload, which every `theme-json.sh set` of a real settings_data.json triggers — must not pin the
# store engine for later calls: that call said nothing about the store, and the engine still works.
QT13="$TMP/probe-percall"; mkdir -p "$QT13"
BIGV="$TMP/bigvars.json"
node -e 'const o={};for(let i=0;i<3000;i++)o["k"+i]="v".repeat(40);require("fs").writeFileSync(process.argv[1],JSON.stringify(o))' "$BIGV"
rc=0; GQL_TMPDIR="$QT13" FAKE_EXEC_MODE=ok \
  run_gql --query query.graphql --variables-file "$BIGV" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -q 'variables too large' "$E" \
   && [ ! -f "$(gql_state "$QT13")/store-skip-test-store.myshopify.com" ]; then ok
else bad G32-percall-skip-not-recorded "rc=$rc err=$(head -c 160 "$E" | tr '\n' ' ') mark=$(ls "$(gql_state "$QT13")" | tr '\n' ' ')"; fi
L10="$TMP/sl10"; : > "$L10"
rc=0; GQL_TMPDIR="$QT13" GQL_LOG="$L10" FAKE_EXEC_MODE=ok \
  run_gql --query query.graphql >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -q '"data":{"ok":true}' "$O" && [ "$(grep -c 'store execute' "$L10")" -eq 1 ]; then ok
else bad G32b-store-engine-still-used "rc=$rc out=$(head -c 100 "$O") calls=[$(tr '\n' ';' < "$L10")]"; fi

# G33 (bug): the TTL is an expiry, not a sliding window — a call SERVED FROM the mark must not
# re-stamp it, or the verdict never ages out on a machine that runs the runner at least once per TTL
# (and the stored reason grows one "(cached — …)" suffix per call, which the next full note prints).
QT14="$TMP/probe-slide"; mkdir -p "$QT14"
rc=0; GQL_TMPDIR="$QT14" run_gql --query query.graphql >"$O" 2>"$E" || rc=$?
SD14="$(gql_state "$QT14")/store-skip-test-store.myshopify.com"
planted=$(( $(date +%s) - 21300 ))
printf '%s\nunexpected CLI crash output\n' "$planted" > "$SD14"
for _ in 1 2 3; do GQL_TMPDIR="$QT14" run_gql --query query.graphql >"$O" 2>"$E" || true; done
if [ "$(head -1 "$SD14")" = "$planted" ]; then ok
else bad G33-skip-mark-not-slid "ts moved $planted -> $(head -1 "$SD14")"; fi
if [ "$(grep -c 'cached — ' "$SD14")" -eq 0 ]; then ok
else bad G33b-reason-accretion "stored reason: $(sed -n 2p "$SD14" | head -c 200)"; fi

# G34: a legacy private-app admin password (shppa_) is a valid X-Shopify-Access-Token — the file
# shape gate catches a typo/placeholder (G17), not a token vintage
printf 'SHOPIFY_ADMIN_TOKEN=shppa_legacyprivateapp\n' > "$ENVD/legacy.env"
rc=0; M="$TMP/m34"; CURL_MARKER="$M" GQL_TOKEN="" \
  run_gql --engine token --query query.graphql --env "$ENVD/legacy.env" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && hdr_is shppa_legacyprivateapp "$M.hdr"; then ok
else bad G34-legacy-token-shape "rc=$rc err=$(head -c 160 "$E" | tr '\n' ' ')"; fi

# G34b: the charset gate exists to stop a quote/newline breaking out into a second curl directive
# (G18b) — base64-ish characters cannot, and $SHOPIFY_ADMIN_TOKEN is documented as the escape hatch
# for a non-standard credential, so they must reach the header
rc=0; M="$TMP/m34b"; CURL_MARKER="$M" GQL_TOKEN='abcd+/==' \
  run_gql --engine token --query query.graphql >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && hdr_is 'abcd+/==' "$M.hdr"; then ok
else bad G34b-base64-token "rc=$rc err=$(head -c 160 "$E" | tr '\n' ' ')"; fi

# G35: the state dir must be 0700 and this uid's before a single byte of state is read or written —
# a pre-existing world-writable dir at the (predictable) path is tightened first. The cross-uid half
# of the guard (`[ -O ]`) cannot be simulated with one uid.
QT15="$TMP/state-loose"; mkdir -p "$QT15"
mkdir -p -m 777 "$(gql_state "$QT15")"
rc=0; GQL_TMPDIR="$QT15" run_gql --query query.graphql >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ "$(ls -ld "$(gql_state "$QT15")" | cut -c1-10)" = "drwx------" ]; then ok
else bad G35-loose-state-dir-tightened "rc=$rc mode=$(ls -ld "$(gql_state "$QT15")" | cut -c1-10)"; fi

# G36 (bug): the state-dir symlink guard, pointed at an EXISTING directory — the shape that actually
# reaches the `[ -L ]` guard. (A dangling target never gets there: `mkdir -p` fails on it first on
# BSD, which is why G20 can only pin the weaker no-write/no-crash half.)
QT16="$TMP/state-symlink-dir"; mkdir -p "$QT16" "$TMP/symlink-target"
ln -s "$TMP/symlink-target" "$(gql_state "$QT16")"
rc=0; GQL_TMPDIR="$QT16" run_gql --query query.graphql >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -q '"ok":true' "$O" && [ -z "$(ls -A "$TMP/symlink-target")" ] \
   && [ "$(ls -ld "$TMP/symlink-target" | cut -c1-10)" != "drwx------" ]; then ok
else bad G36-symlink-to-dir "rc=$rc left=$(ls -A "$TMP/symlink-target" | tr '\n' ' ') mode=$(ls -ld "$TMP/symlink-target" | cut -c1-10)"; fi

# G37 (bug): a planted fifo at a state path blocks the run forever when the write is a plain
# redirect and the read is unguarded — with the 2>/dev/null swallowing the reason. The atomic
# temp+`mv` write and the `[ ! -L ]` read guards are what keep this bounded. The harness runs the
# case under a wall-clock cap (gql_bounded) and kill_tree kills
# the whole descendant tree, so a REGRESSION here fails the case instead of leaving a process blocked
# on the fifo forever — which would hang this suite (and anything reading its output) rather than
# report anything
kill_tree() { local p="$1" c
  for c in $(pgrep -P "$p" 2>/dev/null); do kill_tree "$c"; done
  kill -9 "$p" 2>/dev/null || true
}
gql_bounded() { # gql_bounded <seconds> <args…> — 0 = finished in time, 1 = still running
  local limit="$1"; shift
  ( run_gql "$@" >"$O" 2>"$E" ) & local p=$! i=0
  while kill -0 "$p" 2>/dev/null && [ "$i" -lt $((limit * 10)) ]; do sleep 0.1; i=$((i + 1)); done
  if kill -0 "$p" 2>/dev/null; then kill_tree "$p"; wait "$p" 2>/dev/null; return 1; fi
  wait "$p" 2>/dev/null; return 0
}
QT17="$TMP/state-fifo"; mkdir -p "$(gql_state "$QT17")"
mkfifo "$(gql_state "$QT17")/note-test-store.myshopify.com"
if GQL_TMPDIR="$QT17" gql_bounded 6 --query query.graphql; then ok
else bad G37-fifo-no-hang "the run blocked on a planted fifo"; fi
# A symlink at a state FILE path is never followed: not read THROUGH (a file someone else controls
# would otherwise dictate this run's engine verdict and CLI version) and not written through (a
# dangling one would create a file wherever it points).
QT18="$TMP/state-file-symlink"; mkdir -p "$(gql_state "$QT18")"
printf '%s\nplanted verdict\n' "$(date +%s)" > "$TMP/planted-verdict"
printf '%s 9.9.9\n%s\n' "$(date +%s)" "$SHIM/shopify" > "$TMP/planted-version"
ln -s "$TMP/planted-verdict" "$(gql_state "$QT18")/store-skip-test-store.myshopify.com"
ln -s "$TMP/planted-version" "$(gql_state "$QT18")/cli-version"
ln -s "$TMP/planted-target" "$(gql_state "$QT18")/note-test-store.myshopify.com"
L11="$TMP/sl11"; : > "$L11"
rc=0; GQL_TMPDIR="$QT18" GQL_LOG="$L11" run_gql --query query.graphql >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ ! -e "$TMP/planted-target" ] \
   && [ "$(grep -c '^version' "$L11")" -eq 1 ] && [ "$(grep -c 'store execute' "$L11")" -eq 1 ] \
   && ! grep -q 'planted verdict' "$E" && [ "$(sed -n 2p "$TMP/planted-verdict")" = "planted verdict" ]; then ok
else bad G37b-state-file-symlink "rc=$rc planted=$([ -e "$TMP/planted-target" ] && echo created || echo absent) calls=[$(tr '\n' ';' < "$L11")] err=$(head -c 120 "$E" | tr '\n' ' ')"; fi

# G38 (pin): the version cache round-trips through `read`, which strips whitespace — so the live
# probe is trimmed the same way and a padded `shopify version` cannot make the warm call report a
# different reason than the cold one
QT19="$TMP/probe-padded"; mkdir -p "$QT19"
rc=0; GQL_TMPDIR="$QT19" FAKE_VERSION='  3.66.1' \
  run_gql --engine store --query query.graphql >"$O" 2>"$TMP/e38a" || rc=$?
a_rc=$rc
rc=0; GQL_TMPDIR="$QT19" FAKE_VERSION='  3.66.1' \
  run_gql --engine store --query query.graphql >"$O" 2>"$TMP/e38b" || rc=$?
if [ "$a_rc" -eq 3 ] && [ "$rc" -eq 3 ] && cmp -s "$TMP/e38a" "$TMP/e38b" \
   && grep -q 'has no `store execute`' "$TMP/e38a"; then ok
else bad G38-padded-version-cold-warm "a_rc=$a_rc b_rc=$rc cold=$(head -c 120 "$TMP/e38a") warm=$(head -c 120 "$TMP/e38b")"; fi

# G39 (pin): an empty version probe is never cached — not in cli-version AND not laundered into a
# sticky skip mark: a CLI that prints nothing today may print a version tomorrow, and either cache
# would pin the unparseable-version verdict for the TTL. Runs under --engine auto because
# --engine store exits before the mark-write and cannot catch the skip-mark half.
QT20="$TMP/probe-empty"; mkdir -p "$QT20"
rc=0; GQL_TMPDIR="$QT20" FAKE_VERSION= run_gql --query query.graphql >"$O" 2>"$E" || rc=$?
cold_ver_cached=$([ -f "$(gql_state "$QT20")/cli-version" ] && echo yes || echo no)
cold_skip_cached=$([ -f "$(gql_state "$QT20")/store-skip-test-store.myshopify.com" ] && echo yes || echo no)
L39="$TMP/sl39"; : > "$L39"
rc2=0; GQL_TMPDIR="$QT20" GQL_LOG="$L39" run_gql --query query.graphql >"$O" 2>"$TMP/e39b" || rc2=$?
if [ "$rc" -eq 0 ] && grep -q "unparseable shopify CLI version ''" "$E" \
   && [ "$cold_ver_cached" = no ] && [ "$cold_skip_cached" = no ] \
   && [ "$(grep -c '^version' "$L39")" -eq 1 ]; then ok
else bad G39-empty-version-not-cached "rc=$rc rc2=$rc2 ver_cached=$cold_ver_cached skip_cached=$cold_skip_cached warm_calls=[$(tr '\n' ';' < "$L39")]"; fi

# G40 (bug): an execute that ran and failed for an UNRECOGNIZED reason (network drop, 5xx, crash)
# must NOT pin the store engine — the next call re-attempts and succeeds once the transient clears
QT21="$TMP/probe-transient"; mkdir -p "$QT21"
rc=0; GQL_TMPDIR="$QT21" FAKE_EXEC_MODE=garbage run_gql --query query.graphql >"$O" 2>"$E" || rc=$?
L40="$TMP/sl40"; : > "$L40"
rc2=0; GQL_TMPDIR="$QT21" GQL_LOG="$L40" FAKE_EXEC_MODE=ok run_gql --query query.graphql >"$O" 2>"$TMP/e40b" || rc2=$?
if [ "$rc" -eq 0 ] \
   && [ ! -f "$(gql_state "$QT21")/store-skip-test-store.myshopify.com" ] \
   && [ "$rc2" -eq 0 ] && grep -q '"data":{"ok":true}' "$O" \
   && [ "$(grep -c 'store execute' "$L40")" -eq 1 ]; then ok
else bad G40-transient-execute-not-sticky "rc=$rc rc2=$rc2 mark=$([ -f "$(gql_state "$QT21")/store-skip-test-store.myshopify.com" ] && echo yes || echo no) out=$(head -c 80 "$O")"; fi

# G41: a warm call SERVED FROM the skip mark still names its escape hatch in the short note —
# the full note printed once long ago, and without the suffix FND_GQL_PROBE_CACHE=0 is unreachable
QT22="$TMP/probe-shortnote"; mkdir -p "$QT22"
rc=0; GQL_TMPDIR="$QT22" FAKE_EXEC_MODE=noauth run_gql --query query.graphql >"$O" 2>"$E" || rc=$?
rc2=0; GQL_TMPDIR="$QT22" run_gql --query query.graphql >"$O" 2>"$TMP/e41" || rc2=$?
if [ "$rc" -eq 0 ] && [ "$rc2" -eq 0 ] \
   && grep -q 'note=engine=token (store-skip cached — FND_GQL_PROBE_CACHE=0 re-probes)' "$TMP/e41"; then ok
else bad G41-cached-short-note-hint "rc=$rc rc2=$rc2 err=$(head -c 160 "$TMP/e41" | tr '\n' ' ')"; fi

# G42 (bug): the runner's own toml read — an unreadable-but-present toml is error=no_store, never
# raw awk noise killing the script under set -e with no error= line (same shape as T33)
UT42="$TMP/unreadable-g.toml"; printf 'store = "acme-dev"\n' > "$UT42"; chmod 000 "$UT42"
rc=0; TOML_PATH="$UT42" gql_run_at "$GQLDIR" --query query.graphql >"$O" 2>"$E" || rc=$?
chmod 644 "$UT42"
if [ "$rc" -eq 2 ] && grep -q 'error=no_store' "$E" && ! grep -qi "awk: can't open" "$E"; then ok
else bad G42-unreadable-toml-no-store "rc=$rc err=$(head -c 160 "$E" | tr '\n' ' ')"; fi

# ---------------------------------------- create-preview-theme.sh cap classifier --
CAP_RE='theme limit|maximum number of themes|too many themes'
if grep -qF "$CAP_RE" "$CPT"; then ok; else bad C1-pattern-in-script "cap regex in the test drifted from the script"; fi
if printf 'You have reached your theme limit.\n' | grep -qiE "$CAP_RE"; then ok; else bad C2-real-cap "true cap message not classified"; fi
if printf 'The maximum number of themes has been reached\n' | grep -qiE "$CAP_RE"; then ok; else bad C3-real-cap2 "true cap message not classified"; fi
if printf 'Error pushing theme: rate limit exceeded, too many requests\n' | grep -qiE "$CAP_RE"; then
  bad C4-rate-limit-fp "rate-limit stderr still classified as theme cap"
else ok; fi

# -------------------------------------- create-preview-theme.sh against a stub CLI --
# The script is driven with a PATH shim for `shopify` that appends every argv line (and the
# Theme Access token it was handed) to $CPT_LOG, so "the push never ran" / "the orphan was
# deleted" are assertable, not inferred from the report.
# NB create-preview-theme.sh prints error= on STDOUT, not stderr — every case greps $O.
CPTD="$TMP/cpt"; mkdir -p "$CPTD/shim" "$CPTD/repo/assets" "$CPTD/toml"
cp "$CPT" "$CPTD/cpt.sh"
printf 'x{}\n' > "$CPTD/repo/assets/app.css"
cat > "$CPTD/repo/shopify.theme.toml" <<'EOF'
[environments.development]
store = "acme-dev"
theme = "111"
password = "shptka_fixture1234"
EOF
printf "[environments.development]\nstore = 'acme-dev'\ntheme = '111'\npassword = 'shptka_fixture1234'\n" > "$CPTD/toml/single.toml"
printf '[environments.development]\nstore = acme-dev   # legacy handle\ntheme = 111  # dev\npassword = "shptka_fixture1234"\n' > "$CPTD/toml/bare.toml"
printf "[environments.development]\nstore = 'acme-dev'\ntheme = 'theme = 111'\npassword = 'shptka_fixture1234'\n" > "$CPTD/toml/badid.toml"
printf "[environments.development]\nstore = 'acme dev'\ntheme = '111'\npassword = 'shptka_fixture1234'\n" > "$CPTD/toml/badstore.toml"

# fake shopify CLI. GOTCHA: never put brace-JSON inside ${VAR:-default} — the first `}` closes the
# expansion, which mangles the list JSON into an EMPTY theme name and looks exactly like a script bug.
cat > "$CPTD/shim/shopify" <<'FAKE'
#!/usr/bin/env bash
if [ -n "${CPT_LOG:-}" ]; then
  printf 'argv=%s\n' "$*" >> "$CPT_LOG"
  printf 'token=%s\n' "${SHOPIFY_CLI_THEME_TOKEN:-}" >> "$CPT_LOG"
fi
is_only=0; case "$*" in *"--only"*) is_only=1 ;; esac
# a push at an EXISTING theme reports that theme back; a new (--unpublished) one gets a fresh id
nid=""; prev=""; for a in "$@"; do
  if [ "$prev" = "--theme" ]; then case "$a" in ''|*[!0-9]*) ;; *) nid="$a" ;; esac; fi
  prev="$a"
done
[ -n "$nid" ] || nid="${FAKE_NEW_ID:-222}"
case "$1 ${2:-}" in
  "theme list")
    [ -n "${FAKE_LIST_FAIL:-}" ] && { echo "Error: could not reach the Admin API" >&2; exit 1; }
    if [ -n "${FAKE_LIST:-}" ]; then printf '%s\n' "$FAKE_LIST"; else cat <<'J'
[{"id":111,"name":"[DEV] Kever","role":"development"},{"id":999,"name":"Live Theme","role":"live"}]
J
    fi ;;
  "theme pull")
    # FAKE_PULL_STUBBORN = a CLI that traps SIGTERM (oclif does), so an unbounded `wait` in the
    # script's cleanup would hold the whole process for the rest of the pull
    [ -n "${FAKE_PULL_STUBBORN:-}" ] && trap '' TERM INT
    [ -n "${CPT_PULL_MARK:-}" ] && : > "$CPT_PULL_MARK"
    [ -n "${FAKE_PULL_SLEEP:-}" ] && sleep "$FAKE_PULL_SLEEP"
    [ -n "${CPT_PULL_DONE:-}" ] && : > "$CPT_PULL_DONE"
    [ -n "${FAKE_PULL_FAIL:-}" ] && { echo "Error: could not pull settings (503)" >&2; exit 1; }
    p=""; prev=""; for a in "$@"; do [ "$prev" = "--path" ] && p="$a"; prev="$a"; done
    mkdir -p "$p/config"; printf '{"current":{"pulled":1}}\n' > "$p/config/settings_data.json" ;;
  "theme push")
    [ "$is_only" -eq 1 ] && [ -n "${FAKE_PUSH_ONLY_FAIL:-}" ] && { printf '%s\n' "$FAKE_PUSH_ONLY_FAIL" >&2; exit 1; }
    [ "$is_only" -eq 0 ] && [ -n "${FAKE_PUSH_CODE_FAIL:-}" ] && { printf '%s\n' "$FAKE_PUSH_CODE_FAIL" >&2; exit 1; }
    printf '{"theme":{"id":%s,"preview_url":"https://acme-dev.myshopify.com/?preview_theme_id=%s","editor_url":"https://admin.shopify.com/store/acme-dev/themes/%s/editor"}}\n' "$nid" "$nid" "$nid" ;;
  "theme delete") [ -n "${FAKE_DELETE_FAIL:-}" ] && exit 1; exit 0 ;;
  "version") echo "4.5.2" ;;
  *) echo "shim: unhandled: $*" >&2; exit 1 ;;
esac
exit 0
FAKE
# a build that only succeeds while the settings pull is already in flight (F3 concurrency probe)
cat > "$CPTD/waitpull.sh" <<'W'
#!/usr/bin/env bash
i=0
while [ "$i" -lt 60 ]; do
  [ -f "${CPT_PULL_MARK:-/dev/null}" ] && exit 0
  sleep 0.1; i=$((i + 1))
done
echo "the settings pull had not started by the end of the build" >&2; exit 1
W
# the same probe, one step stricter: the pull must still be RUNNING when the build ends, which is
# the overlap F3 exists to create — waiting for the start mark alone cannot tell a concurrent pull
# from one that ran to completion before the build began
cat > "$CPTD/overlap.sh" <<'W'
#!/usr/bin/env bash
i=0
while [ "$i" -lt 60 ]; do
  [ -f "${CPT_PULL_MARK:-/dev/null}" ] && break
  sleep 0.1; i=$((i + 1))
done
[ -f "${CPT_PULL_MARK:-/dev/null}" ] || { echo "the settings pull never started" >&2; exit 1; }
[ -f "${CPT_PULL_DONE:-/dev/null}" ] && { echo "the settings pull had already finished" >&2; exit 1; }
exit 0
W
# records that it ran, so a case can assert a refusal landed BEFORE the build
cat > "$CPTD/markbuild.sh" <<'W'
#!/usr/bin/env bash
: > "${CPT_BUILD_MARK:-/dev/null}"
exit 0
W
chmod +x "$CPTD/shim/shopify" "$CPTD/waitpull.sh" "$CPTD/overlap.sh" "$CPTD/markbuild.sh"

run_cpt() { # run_cpt <log-file> <env=val…> -- <args…>   ; stdout -> $O, stderr -> $E
  local log="$1"; shift
  local envs=(); while [ "$1" != "--" ]; do envs+=("$1"); shift; done; shift
  (cd "$CPTD/repo" && PATH="$CPTD/shim:$PATH" CPT_LOG="$log" env "${envs[@]}" \
     "$BASH_BIN" "$CPTD/cpt.sh" "$@") >"$O" 2>"$E"
}
cpt_calls() { grep -c "argv=$1" "$2" 2>/dev/null || true; }

# P1 (bug): `refresh --theme <live id>` must be refused BEFORE any push — a mistyped id
# otherwise ships branch code onto the storefront
rc=0; L="$TMP/cpt1"; : > "$L"; run_cpt "$L" NO=1 -- refresh --theme 999 --no-build || rc=$?
if [ "$rc" -ne 0 ] && grep -q 'error=live_theme_write_refused' "$O" \
   && [ "$(cpt_calls 'theme push' "$L")" -eq 0 ]; then ok
else bad P1-refresh-live-refused "rc=$rc out=$(head -c 160 "$O" | tr '\n' ' ') calls=$(tr '\n' ';' < "$L")"; fi

# P1b (bug): the same guard on the name path — `create --reuse` whose name collides with the
# live theme overlays the storefront with the dev theme's settings
rc=0; L="$TMP/cpt1b"; : > "$L"; run_cpt "$L" NO=1 -- create --name "Live Theme" --reuse --no-build || rc=$?
if [ "$rc" -ne 0 ] && grep -q 'error=live_theme_write_refused' "$O" \
   && [ "$(cpt_calls 'theme push' "$L")" -eq 0 ]; then ok
else bad P1b-reuse-live-refused "rc=$rc out=$(head -c 160 "$O" | tr '\n' ' ') calls=$(tr '\n' ';' < "$L")"; fi

# P1c (pin): a non-live reuse target still goes through
rc=0; L="$TMP/cpt1c"; : > "$L"
run_cpt "$L" FAKE_LIST='[{"id":555,"name":"PREVIEW-X","role":"unpublished"}]' \
  -- create --name "PREVIEW-X" --reuse --no-build || rc=$?
# the name lookup, the ambiguity count and the role guard share ONE `theme list` call
if [ "$rc" -eq 0 ] && grep -q '^theme_id=555$' "$O" && grep -q '^reused=true$' "$O" \
   && [ "$(cpt_calls 'theme list' "$L")" -eq 1 ]; then ok
else bad P1c-reuse-allowed "rc=$rc out=$(tr '\n' ';' < "$O") lists=$(cpt_calls 'theme list' "$L")"; fi

# P2 (bug): single-quoted TOML values used to yield the WHOLE LINE — `--store "store = 'acme-dev'"`
# reached the CLI and `info` still exited 0, which the skill reads as success
rc=0; L="$TMP/cpt2"; : > "$L"
run_cpt "$L" TOML_PATH="$CPTD/toml/single.toml" -- info || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^store=acme-dev$' "$O" && grep -q '^dev_theme_id=111$' "$O" \
   && grep -q '^dev_theme_name=\[DEV\] Kever$' "$O" \
   && grep -q 'argv=theme list --store acme-dev --json' "$L"; then ok
else bad P2-toml-single-quoted "rc=$rc out=$(tr '\n' ';' < "$O") log=$(tr '\n' ';' < "$L")"; fi

# P2b: the same shape for password= used to export the whole line as the Theme Access token,
# which also skipped the shp*_ fallback (fixture token, never a real secret)
if grep -q '^token=shptka_fixture1234$' "$L"; then ok
else bad P2b-toml-single-quoted-token "log=$(tr '\n' ';' < "$L")"; fi

# P2c: bare values with a trailing comment
rc=0; L="$TMP/cpt2c"; : > "$L"
run_cpt "$L" TOML_PATH="$CPTD/toml/bare.toml" -- info || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^store=acme-dev$' "$O" && grep -q '^dev_theme_id=111$' "$O"; then ok
else bad P2c-toml-bare "rc=$rc out=$(tr '\n' ';' < "$O")"; fi

# P3 (bug): a dev theme id that is not digits is a mis-parse or a typo — it must fail loudly
# instead of becoming `--theme "theme = 111"` on a pull that then orphans the pushed theme
rc=0; L="$TMP/cpt3"; : > "$L"
run_cpt "$L" TOML_PATH="$CPTD/toml/badid.toml" -- info || rc=$?
if [ "$rc" -ne 0 ] && grep -q 'error=invalid_dev_theme_id' "$O" && [ ! -s "$L" ]; then ok
else bad P3-bad-theme-id "rc=$rc out=$(tr '\n' ';' < "$O") log=$(tr '\n' ';' < "$L")"; fi

# P3b: a store value that cannot be a shop handle is refused before any CLI call
rc=0; L="$TMP/cpt3b"; : > "$L"
run_cpt "$L" TOML_PATH="$CPTD/toml/badstore.toml" -- info || rc=$?
if [ "$rc" -ne 0 ] && grep -q 'error=invalid_store' "$O" && [ ! -s "$L" ]; then ok
else bad P3b-bad-store "rc=$rc out=$(tr '\n' ';' < "$O") log=$(tr '\n' ';' < "$L")"; fi

# P4 (bug): a failed settings PULL used to orphan the just-created theme — no delete, and not
# even a created_theme= line, so the caller could not name the theme burning a slot
rc=0; L="$TMP/cpt4"; : > "$L"
run_cpt "$L" FAKE_PULL_FAIL=1 -- create --name "PREVIEW-A" --no-build || rc=$?
if [ "$rc" -ne 0 ] && grep -q 'error=overlay_pull_failed' "$O" \
   && grep -q '^created_theme=222$' "$O" && grep -q '^created_theme_deleted=yes$' "$O" \
   && grep -q 'argv=theme delete --store acme-dev --theme 222 --force' "$L"; then ok
else bad P4-pull-fail-cleanup "rc=$rc out=$(tr '\n' ';' < "$O") log=$(tr '\n' ';' < "$L")"; fi

# P5 (bug): a transient/auth overlay-push failure is NOT settings drift — the drift verdict sends
# the developer to manual duplication, so it must be gated on the drift wording
rc=0; L="$TMP/cpt5"; : > "$L"
run_cpt "$L" FAKE_PUSH_ONLY_FAIL='Error: Request failed with status code 503 (Service Unavailable)' \
  -- create --name "PREVIEW-B" --no-build || rc=$?
if [ "$rc" -ne 0 ] && grep -q 'error=overlay_push_failed' "$O" && ! grep -q 'settings_drift' "$O" \
   && grep -q '503' "$O" && grep -q '^created_theme_deleted=yes$' "$O"; then ok
else bad P5-overlay-push-failed "rc=$rc out=$(tr '\n' ';' < "$O")"; fi

# P5b (bug): an auth rejection contains the word "invalid" — it used to match the drift pattern
# directly, which is the highest-confidence wrong verdict of the three
rc=0; L="$TMP/cpt5b"; : > "$L"
run_cpt "$L" FAKE_PUSH_ONLY_FAIL='ERROR: [API] Invalid API key or access token' \
  -- create --name "PREVIEW-C" --no-build || rc=$?
if [ "$rc" -ne 0 ] && grep -q 'error=overlay_push_failed' "$O" && ! grep -q 'settings_drift' "$O"; then ok
else bad P5b-auth-not-drift "rc=$rc out=$(tr '\n' ';' < "$O")"; fi

# P5c (pin): a REAL drift message still reports settings_drift + the manual-duplication path
rc=0; L="$TMP/cpt5c"; : > "$L"
run_cpt "$L" FAKE_PUSH_ONLY_FAIL='sections.custom-hero: Invalid value for "type"; blocks must be defined' \
  -- create --name "PREVIEW-D" --no-build || rc=$?
if [ "$rc" -ne 0 ] && grep -q 'error=settings_drift' "$O" && grep -q '^created_theme_deleted=yes$' "$O"; then ok
else bad P5c-real-drift-kept "rc=$rc out=$(tr '\n' ';' < "$O")"; fi

# P5d (bug): with --reuse nothing is deleted, so the theme is left with this branch's code and
# half-applied settings — that mixed state must be stated, not left for the developer to discover.
# The theme pre-existed this run, so it is reported as `theme=`: `created_theme=` +
# `created_theme_deleted=no` reads as "an orphan I created is still on the store, clean it up".
rc=0; L="$TMP/cpt5d"; : > "$L"
run_cpt "$L" FAKE_LIST='[{"id":555,"name":"PREVIEW-X","role":"unpublished"}]' FAKE_PUSH_ONLY_FAIL='Error: socket hang up' \
  -- create --name "PREVIEW-X" --reuse --no-build || rc=$?
if [ "$rc" -ne 0 ] && grep -q 'error=overlay_push_failed' "$O" && grep -q '^theme=555$' "$O" \
   && ! grep -q '^created_theme' "$O" \
   && grep -q '^reused=true$' "$O" && grep -q '^mixed_state=' "$O" \
   && [ "$(cpt_calls 'theme delete' "$L")" -eq 0 ]; then ok
else bad P5d-reuse-mixed-state "rc=$rc out=$(tr '\n' ';' < "$O") log=$(tr '\n' ';' < "$L")"; fi

# P6 (bug): Shopify allows duplicate theme names — `--reuse` used to pick whichever came first in
# the API's list order, so the target silently flipped between runs
rc=0; L="$TMP/cpt6"; : > "$L"
run_cpt "$L" FAKE_LIST='[{"id":301,"name":"PREVIEW-DUP","role":"unpublished"},{"id":302,"name":"PREVIEW-DUP","role":"unpublished"}]' \
  -- create --name "PREVIEW-DUP" --reuse --no-build || rc=$?
if [ "$rc" -ne 0 ] && grep -q 'error=ambiguous_name' "$O" && grep -q -- '--theme' "$O" \
   && grep -q '301' "$O" && grep -q '302' "$O" \
   && [ "$(cpt_calls 'theme push' "$L")" -eq 0 ]; then ok
else bad P6-ambiguous-name "rc=$rc out=$(tr '\n' ';' < "$O") log=$(tr '\n' ';' < "$L")"; fi

# P7 (F3): the settings pull runs CONCURRENTLY with the build — the build command here only
# succeeds once the pull has started, so a serial script fails this case
rc=0; L="$TMP/cpt7"; : > "$L"; PM="$TMP/cpt7.pull"; rm -f "$PM"
run_cpt "$L" CPT_PULL_MARK="$PM" -- create --name "PREVIEW-E" --build-cmd "$CPTD/waitpull.sh" || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^theme_id=222$' "$O" && grep -q '^built=yes$' "$O" \
   && grep -q '^preview_url=https://' "$O" && [ -f "$PM" ]; then ok
else bad P7-pull-concurrent-with-build "rc=$rc out=$(tr '\n' ';' < "$O") err=$(head -c 160 "$E" | tr '\n' ' ')"; fi

# P7b (F3): a backgrounded pull that FAILS must never become a silent success, even when the
# build outlives it (the `wait` status is the only evidence left by then)
rc=0; L="$TMP/cpt7b"; : > "$L"; PM="$TMP/cpt7b.pull"; rm -f "$PM"
run_cpt "$L" CPT_PULL_MARK="$PM" FAKE_PULL_FAIL=1 -- create --name "PREVIEW-F" --build-cmd "$CPTD/waitpull.sh" || rc=$?
if [ "$rc" -ne 0 ] && grep -q 'error=overlay_pull_failed' "$O" && grep -q '^created_theme_deleted=yes$' "$O"; then ok
else bad P7b-background-pull-failure-propagates "rc=$rc out=$(tr '\n' ';' < "$O")"; fi

# P7c (F3 pin): error PRECEDENCE is caller-visible — a code-push failure still reports
# push_code_failed even though the settings pull already failed in the background
rc=0; L="$TMP/cpt7c"; : > "$L"
run_cpt "$L" FAKE_PULL_FAIL=1 FAKE_PUSH_CODE_FAIL='Error: asset rejected' \
  -- create --name "PREVIEW-G" --no-build || rc=$?
if [ "$rc" -ne 0 ] && grep -q 'error=push_code_failed' "$O" && ! grep -q 'overlay_pull_failed' "$O" \
   && [ "$(cpt_calls 'theme delete' "$L")" -eq 0 ]; then ok
else bad P7c-error-precedence "rc=$rc out=$(tr '\n' ';' < "$O") log=$(tr '\n' ';' < "$L")"; fi

# P8 (pin): the happy path — code push ignores settings, the overlay pushes settings only
# (temp-dir cleanup is P14/P14b's job)
rc=0; L="$TMP/cpt8"; : > "$L"
run_cpt "$L" NO=1 -- create --name "PREVIEW-H" --no-build || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^theme_id=222$' "$O" && grep -q '^reused=false$' "$O" \
   && grep -q '^built=skipped$' "$O" \
   && grep -q 'argv=theme push --store acme-dev --unpublished --theme PREVIEW-H .*--ignore config/settings_data.json' "$L" \
   && grep -q 'argv=theme push --store acme-dev --theme 222 .*--only config/settings_data.json' "$L" \
   && [ "$(cpt_calls 'theme delete' "$L")" -eq 0 ]; then ok
else bad P8-happy-path "rc=$rc out=$(tr '\n' ';' < "$O") log=$(tr '\n' ';' < "$L")"; fi

# P9 (pin): the theme-cap classifier still short-circuits before push_code_failed
rc=0; L="$TMP/cpt9"; : > "$L"
run_cpt "$L" FAKE_PUSH_CODE_FAIL='You have reached your theme limit.' \
  -- create --name "PREVIEW-I" --no-build || rc=$?
if [ "$rc" -ne 0 ] && grep -q 'error=theme_limit' "$O" && ! grep -q 'push_code_failed' "$O"; then ok
else bad P9-theme-limit "rc=$rc out=$(tr '\n' ';' < "$O")"; fi

# P10 (pin): refresh onto a non-live theme pushes CODE only and never touches settings
rc=0; L="$TMP/cpt10"; : > "$L"
run_cpt "$L" NO=1 -- refresh --theme 111 --no-build || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^theme_id=111$' "$O" \
   && [ "$(cpt_calls 'theme pull' "$L")" -eq 0 ] \
   && ! grep -q -- '--only' "$L"; then ok
else bad P10-refresh-code-only "rc=$rc out=$(tr '\n' ';' < "$O") log=$(tr '\n' ';' < "$L")"; fi

# P13 (pin): `--reuse` with NO name match creates a new unpublished theme (the ambiguity count and
# the id filter must not abort the run on the empty set under `set -euo pipefail`)
rc=0; L="$TMP/cpt13"; : > "$L"
run_cpt "$L" NO=1 -- create --name "PREVIEW-NEW" --reuse --no-build || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^theme_id=222$' "$O" && grep -q '^reused=false$' "$O" \
   && grep -q 'argv=theme push --store acme-dev --unpublished --theme PREVIEW-NEW ' "$L"; then ok
else bad P13-reuse-no-match "rc=$rc out=$(tr '\n' ';' < "$O") log=$(tr '\n' ';' < "$L")"; fi

# P11 (pin): the live guard is a POSITIVE match — when `theme list` itself fails the role is
# unknown and the refresh proceeds, so a listing outage cannot brick every preview refresh
rc=0; L="$TMP/cpt11"; : > "$L"
run_cpt "$L" FAKE_LIST_FAIL=1 -- refresh --theme 111 --no-build || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^theme_id=111$' "$O" && ! grep -q 'error=' "$O"; then ok
else bad P11-list-outage-not-fatal "rc=$rc out=$(tr '\n' ';' < "$O")"; fi

# P12 (pin): a CRLF toml — the quoted value stops at the closing quote and a bare one drops the CR,
# so the digits assertion cannot turn a Windows-edited config into a hard failure
printf '[environments.development]\r\nstore = "acme-dev"\r\ntheme = 111\r\npassword = "shptka_fixture1234"\r\n' > "$CPTD/toml/crlf.toml"
rc=0; L="$TMP/cpt12"; : > "$L"
run_cpt "$L" TOML_PATH="$CPTD/toml/crlf.toml" -- info || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^store=acme-dev$' "$O" && grep -q '^dev_theme_id=111$' "$O"; then ok
else bad P12-toml-crlf "rc=$rc out=$(tr '\n' ';' < "$O" | tr -d '\r')"; fi

# P14 (F3): an early exit kills the in-flight pull WITHOUT leaking the shell's own "Terminated: 15"
# job report into the script's output, and leaves nothing behind in $TMPDIR. The leftover check only
# means something because every temp path is built from an explicit $TMPDIR template — BSD mktemp
# ignores the variable otherwise, and the assertion would pass with cleanup deleted.
CPTT="$TMP/cpt-tmpdir"; mkdir -p "$CPTT"
rc=0; L="$TMP/cpt14"; : > "$L"
run_cpt "$L" TMPDIR="$CPTT" FAKE_PULL_SLEEP=3 -- create --name "PREVIEW-J" --build-cmd "exit 1" || rc=$?
if [ "$rc" -ne 0 ] && grep -q 'error=build_failed' "$O" \
   && ! grep -qi 'terminated' "$O" "$E" \
   && [ "$(ls -A "$CPTT" | wc -l | tr -d ' ')" -eq 0 ]; then ok
else bad P14-early-exit-clean "rc=$rc out=$(tr '\n' ';' < "$O") err=$(tr '\n' ';' < "$E") left=$(ls -A "$CPTT" | tr '\n' ' ')"; fi

# P14b (bug): the same early exit against a CLI that IGNORES SIGTERM. `kill` + an unbounded `wait`
# holds the process for the rest of the pull — the report is already on stdout, but the caller
# blocks on process exit, so a 1 s failure reads as a multi-minute one.
CPTT2="$TMP/cpt-tmpdir2"; mkdir -p "$CPTT2"
rc=0; L="$TMP/cpt14b"; : > "$L"
t0=$(date +%s)
run_cpt "$L" TMPDIR="$CPTT2" FAKE_PULL_STUBBORN=1 FAKE_PULL_SLEEP=8 -- create --name "PREVIEW-K" --build-cmd "exit 1" || rc=$?
elapsed=$(( $(date +%s) - t0 ))
if [ "$rc" -ne 0 ] && grep -q 'error=build_failed' "$O" && [ "$elapsed" -le 3 ] \
   && [ "$(ls -A "$CPTT2" | wc -l | tr -d ' ')" -eq 0 ]; then ok
else bad P14b-stubborn-pull-bounded "rc=$rc elapsed=${elapsed}s left=$(ls -A "$CPTT2" | tr '\n' ' ')"; fi

# P15 (F3 pin): the pull must still be RUNNING when the build ends — that overlap IS the speedup, and
# nothing else in the suite can tell it apart from a pull that completed before the build started
rc=0; L="$TMP/cpt15"; : > "$L"; PM="$TMP/cpt15.start"; PD="$TMP/cpt15.done"; rm -f "$PM" "$PD"
run_cpt "$L" CPT_PULL_MARK="$PM" CPT_PULL_DONE="$PD" FAKE_PULL_SLEEP=2 \
  -- create --name "PREVIEW-L" --build-cmd "$CPTD/overlap.sh" || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^theme_id=222$' "$O" && grep -q '^built=yes$' "$O" && [ -f "$PD" ]; then ok
else bad P15-pull-still-running-at-build-end "rc=$rc out=$(tr '\n' ';' < "$O") err=$(head -c 200 "$E" | tr '\n' ' ')"; fi

# P16 (bug): a `theme list` that comes back UNREADABLE (the CLI prints a deprecation/upgrade banner
# before the JSON — the shape json_field is written tolerantly for) must not disarm the live-theme
# guard. A positive match is impossible on a document jq cannot parse, so "no role" means UNKNOWN.
BANNER_LIST='Upgrade available: run `npm i -g @shopify/cli`
[{"id":999,"name":"Live Theme","role":"live"},{"id":111,"name":"[DEV] Kever","role":"development"}]'
rc=0; L="$TMP/cpt16"; : > "$L"
run_cpt "$L" FAKE_LIST="$BANNER_LIST" -- refresh --theme 999 --no-build || rc=$?
if [ "$rc" -ne 0 ] && grep -q 'error=live_theme_write_refused' "$O" \
   && [ "$(cpt_calls 'theme push' "$L")" -eq 0 ]; then ok
else bad P16-banner-live-refused "rc=$rc out=$(head -c 160 "$O" | tr '\n' ' ') calls=$(tr '\n' ';' < "$L")"; fi

# P16b: the banner does not break the ordinary lookups either
rc=0; L="$TMP/cpt16b"; : > "$L"
run_cpt "$L" FAKE_LIST="$BANNER_LIST" -- refresh --theme 111 --no-build || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^theme_id=111$' "$O"; then ok
else bad P16b-banner-nonlive-ok "rc=$rc out=$(tr '\n' ';' < "$O")"; fi

# P16d (bug): noise glued to the JSON's OWN line (an oclif spinner artifact `⠋ Fetching themes\r[…`,
# stray ANSI under FORCE_COLOR) — the salvage is byte-anchored, so this parses instead of turning
# into a cli_list_unreadable lockout on a perfectly healthy store
rc=0; L="$TMP/cpt16d"; : > "$L"
run_cpt "$L" FAKE_LIST='Fetching themes... [{"id":999,"name":"Live Theme","role":"live"},{"id":111,"name":"[DEV] Kever","role":"development"}]' \
  -- refresh --theme 111 --no-build || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^theme_id=111$' "$O"; then ok
else bad P16d-sameline-noise-salvaged "rc=$rc out=$(head -c 160 "$O" | tr '\n' ' ')"; fi

# P16c: a listing that came back and is not JSON at all is refused, not waved through — unlike an
# EMPTY listing (P11: the call failed, role unknown, proceed) this one is output we cannot read
rc=0; L="$TMP/cpt16c"; : > "$L"
run_cpt "$L" FAKE_LIST='<html>503 Service Unavailable</html>' -- refresh --theme 111 --no-build || rc=$?
if [ "$rc" -ne 0 ] && grep -q 'error=cli_list_unreadable' "$O" \
   && [ "$(cpt_calls 'theme push' "$L")" -eq 0 ]; then ok
else bad P16c-unreadable-list-refused "rc=$rc out=$(head -c 160 "$O" | tr '\n' ' ') calls=$(tr '\n' ';' < "$L")"; fi

# P17 (bug): the same unreadable listing on the --reuse path. "No match" out of a document we cannot
# parse is not "the theme does not exist" — creating here adds a SECOND theme with that name, which
# the ambiguity guard then blocks on every later run until a human deletes one in the admin.
rc=0; L="$TMP/cpt17"; : > "$L"
run_cpt "$L" FAKE_LIST='<html>503</html>' -- create --name "PREVIEW-M" --reuse --no-build || rc=$?
if [ "$rc" -ne 0 ] && grep -q 'error=cli_list_unreadable' "$O" \
   && [ "$(cpt_calls 'theme push' "$L")" -eq 0 ]; then ok
else bad P17-reuse-unreadable-list "rc=$rc out=$(head -c 160 "$O" | tr '\n' ' ') calls=$(tr '\n' ';' < "$L")"; fi

# P17b (bug): a name that DOES match, listed with a non-numeric id — the digit filter drops it, and
# a silent "no match" would again create a duplicate. Fail loudly instead.
rc=0; L="$TMP/cpt17b"; : > "$L"
run_cpt "$L" FAKE_LIST='[{"id":"gid://shopify/OnlineStoreTheme/700","name":"PREVIEW-N","role":"unpublished"}]' \
  -- create --name "PREVIEW-N" --reuse --no-build || rc=$?
if [ "$rc" -ne 0 ] && grep -q 'error=unusable_theme_id' "$O" \
   && [ "$(cpt_calls 'theme push' "$L")" -eq 0 ]; then ok
else bad P17b-nonnumeric-id "rc=$rc out=$(head -c 160 "$O" | tr '\n' ' ') calls=$(tr '\n' ';' < "$L")"; fi

# P18 (pin): every alternative of the drift pattern has its own fixture, so the pattern cannot be
# narrowed back without a red case; and a non-drift failure still reports a REAL cause= line, never
# the placeholder — that field is what the caller acts on
drift_case() { # drift_case <label> <stderr line> <expected error code>
  local lrc=0
  run_cpt "$TMP/cptdrift" FAKE_PUSH_ONLY_FAIL="$2" -- create --name "PREVIEW-DR" --no-build || lrc=$?
  if [ "$lrc" -ne 0 ] && grep -q "^error=$3\$" "$O" && grep -qF "cause=$2" "$O"; then ok
  else bad "$1" "rc=$lrc want=$3 out=$(head -2 "$O" | tr '\n' ';')"; fi
}
drift_case P18a-drift-must-be-defined 'sections.hero: the setting "x" must be defined' settings_drift
drift_case P18b-drift-invalid-value   'Invalid value for setting "layout"' settings_drift
drift_case P18c-drift-not-synced      'templates/product.json could not be synced' settings_drift
drift_case P18d-drift-invalid-section 'Invalid section type "custom-hero" in templates/product.json' settings_drift
drift_case P18e-drift-missing-type    "Section type 'hero' does not exist in this theme" settings_drift
drift_case P18f-drift-invalid-setting "Invalid setting 'foo' in config/settings_data.json" settings_drift
drift_case P18g-transient-real-cause  'Error: socket hang up' overlay_push_failed
drift_case P18h-auth-real-cause       'ERROR: [API] Invalid API key or access token' overlay_push_failed
drift_case P18i-unworded-real-cause   'Request rejected by the upstream proxy' overlay_push_failed

# P19 (pin): a refusal must land BEFORE the build — a refusal a developer waited several minutes of
# npm for is the whole reason the reuse/live block was moved above run_build
rc=0; L="$TMP/cpt19"; : > "$L"; BM="$TMP/cpt19.build"; rm -f "$BM"
run_cpt "$L" CPT_BUILD_MARK="$BM" -- create --name "Live Theme" --reuse --build-cmd "$CPTD/markbuild.sh" || rc=$?
if [ "$rc" -ne 0 ] && grep -q 'error=live_theme_write_refused' "$O" && [ ! -f "$BM" ]; then ok
else bad P19-refusal-before-build "rc=$rc built=$([ -f "$BM" ] && echo yes || echo no) out=$(head -c 120 "$O" | tr '\n' ' ')"; fi
rc=0; L="$TMP/cpt19b"; : > "$L"; rm -f "$BM"
run_cpt "$L" CPT_BUILD_MARK="$BM" FAKE_LIST='[{"id":301,"name":"PREVIEW-DUP","role":"unpublished"},{"id":302,"name":"PREVIEW-DUP","role":"unpublished"}]' \
  -- create --name "PREVIEW-DUP" --reuse --build-cmd "$CPTD/markbuild.sh" || rc=$?
if [ "$rc" -ne 0 ] && grep -q 'error=ambiguous_name' "$O" && [ ! -f "$BM" ]; then ok
else bad P19b-ambiguous-before-build "rc=$rc built=$([ -f "$BM" ] && echo yes || echo no)"; fi

# P20 (bug): the project's own credential wins over an ambient $SHOPIFY_CLI_THEME_TOKEN — a token
# exported for another project would otherwise authenticate this repo's pushes against that store
rc=0; L="$TMP/cpt20"; : > "$L"
run_cpt "$L" SHOPIFY_CLI_THEME_TOKEN=shptka_STALE_OTHER_PROJECT -- info || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^token=shptka_fixture1234$' "$L"; then ok
else bad P20-toml-token-wins "rc=$rc log=$(tr '\n' ';' < "$L")"; fi

# P20b: with no token in the toml at all the env var is the escape hatch (a credential this file
# cannot supply), so the run still authenticates instead of hard-stopping
printf "[environments.development]\nstore = 'acme-dev'\ntheme = '111'\n" > "$CPTD/toml/notoken.toml"
rc=0; L="$TMP/cpt20b"; : > "$L"
run_cpt "$L" TOML_PATH="$CPTD/toml/notoken.toml" SHOPIFY_CLI_THEME_TOKEN=shptka_from_env -- info || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^token=shptka_from_env$' "$L"; then ok
else bad P20b-env-token-fallback "rc=$rc out=$(tr '\n' ';' < "$O") log=$(tr '\n' ';' < "$L")"; fi

# P21 (bug): `shopify --store` documents the https:// URL form as valid and real tomls carry it —
# it is normalized, not refused
printf '[environments.development]\nstore = "https://acme-dev.myshopify.com"\ntheme = "111"\npassword = "shptka_fixture1234"\n' > "$CPTD/toml/url.toml"
rc=0; L="$TMP/cpt21"; : > "$L"
run_cpt "$L" TOML_PATH="$CPTD/toml/url.toml" -- info || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^store=acme-dev\.myshopify\.com$' "$O" \
   && grep -q 'argv=theme list --store acme-dev\.myshopify\.com --json' "$L"; then ok
else bad P21-store-url-form "rc=$rc out=$(tr '\n' ';' < "$O") log=$(tr '\n' ';' < "$L")"; fi

# P22 (bug): `refresh --theme <NAME>` is refused before any CLI call — the CLI would resolve a name
# to ANY theme (the published one included), but assert_not_live vets by id, so a name target would
# sail past the guard with role="" and push branch code onto the storefront
rc=0; L="$TMP/cpt22"; : > "$L"
run_cpt "$L" NO=1 -- refresh --theme "Live Theme" --no-build || rc=$?
if [ "$rc" -ne 0 ] && grep -q 'error=invalid_theme_id' "$O" \
   && [ "$(grep -c 'argv=' "$L")" -eq 0 ]; then ok
else bad P22-refresh-name-refused "rc=$rc out=$(head -c 160 "$O" | tr '\n' ' ') calls=$(tr '\n' ';' < "$L")"; fi

# P23 (bug): an object that matches the id but carries NO role must refuse, not clear — jq's literal
# `null` (or a role key renamed by list-shape drift) would otherwise satisfy neither guard branch
# and wave through every target, the published theme included
rc=0; L="$TMP/cpt23"; : > "$L"
run_cpt "$L" FAKE_LIST='[{"id":111,"name":"[DEV] Kever"}]' -- refresh --theme 111 --no-build || rc=$?
if [ "$rc" -ne 0 ] && grep -q 'error=live_role_unreadable' "$O" \
   && [ "$(cpt_calls 'theme push' "$L")" -eq 0 ]; then ok
else bad P23-roleless-id-refused "rc=$rc out=$(head -c 160 "$O" | tr '\n' ' ') calls=$(tr '\n' ';' < "$L")"; fi

# P23b (pin): an id ABSENT from a readable listing still proceeds — absence is what a fresh or
# paginated-away theme looks like, and only found-but-roleless is the drift shape P23 refuses
rc=0; L="$TMP/cpt23b"; : > "$L"
run_cpt "$L" FAKE_LIST='[{"id":222,"name":"Other","role":"unpublished"}]' -- refresh --theme 111 --no-build || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^theme_id=111$' "$O"; then ok
else bad P23b-absent-id-proceeds "rc=$rc out=$(head -c 160 "$O" | tr '\n' ' ')"; fi

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

# ---------------------------------------------- json-slim.cjs: Figma design-context JSX (M13) --
# A Figma dev-mode get_design_context payload (generated React/Tailwind JSX) is compacted losslessly:
# className dictionary + node-id legend + ×N sibling fold. Every entry shape is covered — a fenced
# whale over the inline cap (Gate A), the bare trimmed fixture under it, the MCP block envelope a
# spilled result keeps — plus the corruption rail (a Liquid file that merely uses `var(--…)` must pass
# through byte-identical) and the mixed-sibling shape that used to kill the process.
JSXD="$TMP/jsxslim"; mkdir -p "$JSXD"

# X1: a FENCED Figma whale whose compacted body still exceeds the 48 KB inline cap → Gate A spill +
# handback ≤ ~1 KB, stages ["fence","jsx"] in the debug log. classNames are unique here, so the win
# comes from the node-id legend alone — the compacted body stays over the cap on purpose.
X1F="$JSXD/whale.txt"
node -e '
  const el=[];
  for(let i=0;i<1400;i++) el.push(`    <div className="unique-card-${i} content-stretch flex flex-col gap-[var(--space\\/sm,16px)] items-center relative shrink-0 w-full" data-node-id="I13920:2404${i};19010:8137" data-name="Card ${i}">card ${i}</div>`);
  require("fs").writeFileSync(process.argv[1], "Design context:\n```jsx\nexport default function Section() {\n  return (\n" + el.join("\n") + "\n  );\n}\n```");
' "$X1F"
X1OUT="$JSXD/x1out"; mkdir -p "$X1OUT"
rc=0; FND_MCP_SLIM_DIR="$X1OUT" FND_MCP_SLIM_DEBUG=1 node "$SLIM" "$X1F" >"$O" 2>"$E" || rc=$?
outb=$(wc -c < "$O" | tr -d ' ')
x1stages=$(node -e 'const fs=require("fs");const l=fs.readFileSync(process.argv[1],"utf8").trim().split("\n").pop();process.stdout.write(JSON.stringify(JSON.parse(l).stages))' "$X1OUT/fnd-mcp-slim-debug.log" 2>/dev/null || true)
if [ "$rc" -eq 0 ] && [ "$outb" -le 1200 ] && grep -q 'spilled, not printed' "$O" && grep -q "$X1F" "$O" \
   && [ "$x1stages" = '["fence","jsx"]' ] \
   && grep -q 'not JSON — read the slimmed body windowed' "$O" && ! grep -q 'narrow with' "$O"; then ok
else bad X1-fenced-jsx-gateA "rc=$rc outb=$outb stages=$x1stages head=$(head -c 200 "$O")"; fi

# X2: the trimmed REAL fixture (under the cap) → the compacted body prints inline with the legend
# header on top, one `original:` line naming the file (nothing was spilled, so the header must not be
# the only thing pointing anywhere), and the node-id map named in that header — under `ids=`, never
# `full=`, which stays the handle for the original result — resolvable for every #nN.
X2OUT="$JSXD/x2out"; mkdir -p "$X2OUT"
rc=0; FND_MCP_SLIM_DIR="$X2OUT" node "$SLIM" "$ROOT/tests/fixtures/figma-design-context.jsx" >"$O" 2>"$E" || rc=$?
inb=$(wc -c < "$ROOT/tests/fixtures/figma-design-context.jsx" | tr -d ' ')
outb=$(wc -c < "$O" | tr -d ' ')
idmaps=$(ls "$X2OUT" 2>/dev/null | grep -c '^fnd-jsx-ids-' || true)
if [ "$rc" -eq 0 ] && head -1 "$O" | grep -Fq '<<fnd-jsx-slim>>' && [ "$idmaps" -eq 1 ] \
   && node -e "process.exit($outb/$inb < 0.45 ? 0 : 1)" \
   && grep -Fq "original: $ROOT/tests/fixtures/figma-design-context.jsx" "$O" \
   && ! grep -Fq 'full=' "$O" \
   && node -e '
     const fs=require("fs"),path=require("path");
     const body=fs.readFileSync(process.argv[1],"utf8");
     const m=/ids=(\S+)/.exec(body.split("\n")[0]);   // naive, exactly like the model reading this header
     if(!m) process.exit(1);
     let map;
     try{ map=JSON.parse(fs.readFileSync(m[1],"utf8")); }catch(_){ process.exit(1); } // an unreadable path is the failure, not a stack trace
     const refs=[...new Set(body.match(/#n\d+/g)||[])];
     process.exit(refs.length && refs.every((r)=>typeof map[r.slice(1)]==="string") ? 0 : 1);
   ' "$O"; then ok
else bad X2-fixture-inline "rc=$rc inb=$inb outb=$outb idmaps=$idmaps head=$(head -c 200 "$O")"; fi

# X3: a Liquid section that merely uses `var(--…)` is NOT Figma JSX — the CLI hands the path back and
# writes no spill of any kind (the corruption rail: generic markup is never touched).
X3F="$JSXD/section.liquid"
node -e '
  const l=[];
  for(let i=0;i<200;i++) l.push(`{% if section.settings.show_${i} %}\n  <div class="card" style="color: var(--color-text-${i}, #000);">{{ product.title }}</div>\n{% endif %}`);
  require("fs").writeFileSync(process.argv[1], l.join("\n"));
' "$X3F"
X3OUT="$JSXD/x3out"; mkdir -p "$X3OUT"
rc=0; FND_MCP_SLIM_DIR="$X3OUT" node "$SLIM" "$X3F" >"$O" 2>"$E" || rc=$?
x3spills=$(ls "$X3OUT" 2>/dev/null | grep -c '^fnd-' || true)
if [ "$rc" -eq 0 ] && grep -Fq "read the file directly: $X3F" "$O" && [ "$x3spills" -eq 0 ]; then ok
else bad X3-liquid-passthrough "rc=$rc spills=$x3spills head=$(head -c 160 "$O")"; fi

# X4: the MCP block envelope — the shape a design-context result keeps when the platform spills the
# whole result to disk ([{"type":"text","text":"<the JSX>"}]). It parses as JSON, so the jsx stage has
# to unwrap it here or the whale reaches the model uncompacted.
X4F="$JSXD/envelope.json"
node -e '
  const fs=require("fs");
  fs.writeFileSync(process.argv[1], JSON.stringify([{type:"text",text:fs.readFileSync(process.argv[2],"utf8")}]));
' "$X4F" "$ROOT/tests/fixtures/figma-design-context.jsx"
X4OUT="$JSXD/x4out"; mkdir -p "$X4OUT"
rc=0; FND_MCP_SLIM_DIR="$X4OUT" FND_MCP_SLIM_DEBUG=1 node "$SLIM" "$X4F" >"$O" 2>"$E" || rc=$?
x4stages=$(node -e 'const fs=require("fs");const l=fs.readFileSync(process.argv[1],"utf8").trim().split("\n").pop();process.stdout.write(JSON.stringify(JSON.parse(l).stages))' "$X4OUT/fnd-mcp-slim-debug.log" 2>/dev/null || true)
inb=$(wc -c < "$X4F" | tr -d ' '); outb=$(wc -c < "$O" | tr -d ' ')
if [ "$rc" -eq 0 ] && [ "$x4stages" = '["jsx"]' ] && head -1 "$O" | grep -Fq '<<fnd-jsx-slim>>' \
   && node -e "process.exit($outb/$inb < 0.45 ? 0 : 1)"; then ok
else bad X4-envelope-jsx "rc=$rc stages=$x4stages inb=$inb outb=$outb head=$(head -c 160 "$O")"; fi

# X5: mixed sibling shapes (an empty element next to text-bearing ones) used to make the fold index
# past its slot list — an unhandled TypeError that exited 1 with NOTHING on stdout, on exactly the
# `node json-slim.cjs <spill>` command the whale stub hands the model. The CLI always answers.
X5F="$JSXD/mixed.jsx"
node -e '
  const l=["<div className=\"root bg-[var(--c-bg,#fff)]\" data-node-id=\"1:0\" data-name=\"Root\">"];
  l.push("  <p className=\"lbl bg-[var(--c-fg,#000)]\" data-node-id=\"1:1\" data-name=\"L\"></p>");
  for(let i=2;i<=60;i++) l.push(`  <p className="lbl bg-[var(--c-fg,#000)]" data-node-id="1:${i}" data-name="L">Product variant ${i}</p>`);
  l.push("</div>");
  require("fs").writeFileSync(process.argv[1], l.join("\n"));
' "$X5F"
X5OUT="$JSXD/x5out"; mkdir -p "$X5OUT"
rc=0; FND_MCP_SLIM_DIR="$X5OUT" node "$SLIM" "$X5F" >"$O" 2>"$E" || rc=$?
x5kept=$(grep -o 'Product variant' "$O" | wc -l | tr -d ' ')
if [ "$rc" -eq 0 ] && [ -s "$O" ] && [ "$x5kept" -eq 59 ]; then ok
else bad X5-mixed-siblings "rc=$rc kept=$x5kept/59 err=$(head -c 200 "$E")"; fi

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
{"ts":"2026-07-24T10:00:00.000Z","project":"elc","lvl":1,"entry":"hook","tool":"mcp__a__getJiraIssue","decision":"compressed","reason":null,"bytes_in":9062,"bytes_out":5318,"pct":41.3,"stages":["adf","noise","crush"],"spill":"/tmp/fnd-mcp-slim-a.json","ms":7}
{"ts":"2026-07-24T10:05:00.000Z","project":"elc","lvl":1,"entry":"hook","tool":"mcp__a__listFiles","decision":"passthrough","reason":"non-json","format":"text","bytes_in":52518,"bytes_out":52518,"pct":0,"stages":[],"spill":null,"ms":2}
{"ts":"2026-07-24T11:00:00.000Z","project":"elc","lvl":1,"entry":"hook","tool":"mcp__x__evaluate_script","decision":"passthrough","reason":"platform-overflow","bytes_in":1463,"bytes_out":1463,"pct":0,"stages":[],"spill":"/p/tool-results/paired-whale.txt","ms":1}
{"ts":"2026-07-24T11:02:00.000Z","project":"elc","lvl":1,"entry":"cli","tool":"/p/tool-results/paired-whale.txt","decision":"compressed","reason":null,"bytes_in":764124,"bytes_out":123048,"pct":83.9,"stages":["noise","crush"],"spill":null,"spill_out":"/tmp/fnd-slim-out-b.json","ms":36}
{"ts":"2026-07-24T12:00:00.000Z","project":"other","lvl":1,"entry":"hook","tool":"mcp__x__list_network_requests","decision":"passthrough","reason":"platform-overflow","bytes_in":1400,"bytes_out":1400,"pct":0,"stages":[],"spill":"/p/tool-results/lonely-whale.txt","ms":1}
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

# R7 (B4.7): the report's reason vocabulary is data-driven, so the new `marker-overhead` passthrough —
# a compression whose win was smaller than the `full=` handle, handed back as the original — is counted
# like any other passthrough: named under `passthrough reasons`, saving nothing, never a missed whale.
RPLOG4="$RPD/marker-overhead.log"
cat > "$RPLOG4" <<'RPEOF'
{"ts":"2026-07-25T20:00:00.000Z","project":"elc","entry":"hook","tool":"mcp__a__getSettings","decision":"passthrough","reason":"marker-overhead","bytes_in":13337,"bytes_out":13337,"pct":0,"stages":["noise"],"spill":null,"ms":4}
{"ts":"2026-07-25T20:01:00.000Z","project":"elc","entry":"hook","tool":"mcp__a__getJiraIssue","decision":"compressed","reason":null,"bytes_in":9062,"bytes_out":5318,"pct":41.3,"stages":["adf","crush"],"spill":"/tmp/fnd-mcp-slim-c.json","ms":6}
RPEOF
rc=0; node "$SLIM" --report "$RPLOG4" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -Fq 'passthrough reasons: marker-overhead 1' "$O" \
   && grep -Fq 'totals: 22399 → 18655 B (16.7% saved)' "$O" \
   && grep -Fq 'no later json-slim run): 0 of 0' "$O"; then ok
else bad R7-report-marker-overhead "rc=$rc out=$(head -c 500 "$O") err=$(head -c 120 "$E")"; fi

# R8 (B4.10c/B4.11): at FND_MCP_SLIM_DEBUG=1 sub-gate (`size-gate`) lines are not recorded, so the totals
# % and the per-tool/per-project call counts cover LOGGED events only. The report says so in one footnote
# line AND labels the totals — read off the `lvl` each line carries, never guessed from the reasons
# present (one foreign `size-gate` line used to delete the caveat from a report missing 74 % of its
# events, and a =2 log whose results all exceeded the gate used to print it falsely).
rc=0; node "$SLIM" --report "$RPLOG" >"$O" 2>"$E" || rc=$?
lines=$(wc -l < "$O" | tr -d ' ')
if [ "$rc" -eq 0 ] && [ "$lines" -le 40 ] && grep -Fq 'sub-gate results' "$O" && grep -Fq 'FND_MCP_SLIM_DEBUG=2' "$O" \
   && grep -Fq '[level 1 — sub-gate results not logged' "$O"; then ok
else bad R8-subgate-footnote "rc=$rc lines=$lines out=$(head -c 300 "$O")"; fi
# a level-1 log with a stale `size-gate` line from an earlier =2 session keeps the caveat: the level is a
# fact on the line, not an inference from the vocabulary
RPMIX="$RPD/stale-subgate.log"
head -1 "$RPLOG" > "$RPMIX"
printf '%s\n' '{"ts":"2026-07-24T09:00:00.000Z","project":"elc","lvl":2,"entry":"hook","tool":"mcp__a__z","decision":"passthrough","reason":"size-gate","bytes_in":900,"bytes_out":900,"pct":0,"stages":[],"spill":null,"ms":1}' >> "$RPMIX"
rc=0; node "$SLIM" --report "$RPMIX" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -Fq 'sub-gate results' "$O" && grep -Fq '[MIXED levels: 1 at =1' "$O" \
   && grep -Fq 'not comparable' "$O"; then ok
else bad R8c-mixed-levels "rc=$rc out=$(head -c 500 "$O")"; fi
# a PRE-B4.11 log carries no `lvl` at all, and at that time level 1 did record the sub-gate lines — so its
# totals are complete and must get neither the label nor the footnote (RPLOG4 is such a log)
rc=0; node "$SLIM" --report "$RPLOG4" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && ! grep -Fq 'sub-gate results' "$O" && ! grep -Fq 'level 1' "$O"; then ok
else bad R8d-legacy-log-uncaveated "rc=$rc out=$(head -c 400 "$O")"; fi
RPLOG5="$RPD/with-subgate.log"
cat > "$RPLOG5" <<'RPEOF'
{"ts":"2026-07-25T21:00:00.000Z","project":"elc","lvl":2,"entry":"hook","tool":"mcp__a__x","decision":"passthrough","reason":"size-gate","bytes_in":800,"bytes_out":800,"pct":0,"stages":[],"spill":null,"ms":1}
{"ts":"2026-07-25T21:01:00.000Z","project":"elc","lvl":2,"entry":"hook","tool":"mcp__a__y","decision":"compressed","reason":null,"bytes_in":9062,"bytes_out":5318,"pct":41.3,"stages":["crush"],"spill":"/tmp/fnd-mcp-slim-d.json","spills":["/tmp/fnd-mcp-slim-d.json","/tmp/fnd-crush-aa.json"],"ms":6}
{"ts":"2026-07-25T21:02:00.000Z","project":"elc","lvl":2,"entry":"hook","tool":"mcp__a__y","decision":"compressed","reason":null,"bytes_in":9062,"bytes_out":5318,"pct":41.3,"stages":["crush"],"spill":"/tmp/fnd-mcp-slim-d.json","spills":["/tmp/fnd-mcp-slim-d.json","/tmp/fnd-crush-aa.json"],"ms":6}
{"ts":"2026-07-25T21:03:00.000Z","project":"elc","lvl":2,"entry":"hook","tool":"mcp__a__w","decision":"compressed","reason":null,"bytes_in":90620,"bytes_out":5318,"pct":94.1,"stages":["crush"],"spill":"/tmp/fnd-mcp-slim-e.json","spills":["/tmp/fnd-mcp-slim-e.json","/tmp/fnd-crush-b1.json","/tmp/fnd-crush-b2.json","/tmp/fnd-crush-b3.json","/tmp/fnd-crush-b4.json","/tmp/fnd-crush-b5.json","/tmp/fnd-crush-b6.json","/tmp/fnd-crush-b7.json"],"spills_n":12,"ms":9}
RPEOF
# R8b: a =2 log needs no caveat, and `spill files` counts FILES, not references. The two identical events
# name the same two content-addressed paths (summing the per-event lists reported the dedup factor as a
# file count: 1030 names for 23 payloads in the live week that motivated content addressing), and the
# capped line contributes the 8 paths it still names plus an upper bound for the 4 it dropped. The
# ≤40-line budget is asserted HERE, on the log that produces every optional section.
rc=0; node "$SLIM" --report "$RPLOG5" >"$O" 2>"$E" || rc=$?
lines=$(wc -l < "$O" | tr -d ' ')
if [ "$rc" -eq 0 ] && [ "$lines" -le 40 ] && ! grep -Fq 'sub-gate results' "$O" \
   && grep -Fq 'spill files: 10 named by 3 events (+ up to 4 more the capped lines did not name)' "$O"; then ok
else bad R8b-subgate-present "rc=$rc lines=$lines out=$(head -c 500 "$O")"; fi
# R8e: a stub whose json-slim follow-up reduced NOTHING is not compliance — the payload went into context
# anyway. Counted on the stubbed line and on the cli aggregate, instead of reading as "0 unfollowed".
RPLOG6="$RPD/flat-followup.log"
cat > "$RPLOG6" <<'RPEOF'
{"ts":"2026-07-25T22:00:00.000Z","project":"elc","lvl":1,"entry":"hook","tool":"mcp__x__products","decision":"stubbed","reason":"no-gain","format":"json","bytes_in":47565,"bytes_out":795,"pct":98.3,"stages":[],"spill":"/tmp/fnd-mcp-slim-f.json","spills":["/tmp/fnd-mcp-slim-f.json"],"ms":5}
{"ts":"2026-07-25T22:01:00.000Z","project":"elc","lvl":1,"entry":"cli","tool":"/tmp/fnd-mcp-slim-f.json","decision":"passthrough","reason":"no-gain","bytes_in":43364,"bytes_out":43364,"pct":0,"stages":[],"spill":null,"ms":4}
RPEOF
rc=0; node "$SLIM" --report "$RPLOG6" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -Fq '0 with no later json-slim run, 1 whose run gained nothing' "$O" \
   && grep -Fq 'cli runs: 1 · saved 0 B (0.0%) · 1 gained nothing' "$O"; then ok
else bad R8e-flat-followup "rc=$rc out=$(head -c 500 "$O")"; fi
# …but a `--jq` run that reduced nothing ANSWERED a sub-path (it printed one field, not the file) — that is
# the recovery the stub now names, so it must not be counted as the re-dump this line exists to expose.
RPLOG7="$RPD/narrowed-followup.log"
head -1 "$RPLOG6" > "$RPLOG7"
printf '%s\n' '{"ts":"2026-07-25T22:02:00.000Z","project":"elc","lvl":1,"entry":"cli","tool":"/tmp/fnd-mcp-slim-f.json","decision":"passthrough","reason":"no-gain","narrowed":true,"bytes_in":160,"bytes_out":160,"pct":0,"stages":[],"spill":null,"ms":2}' >> "$RPLOG7"
rc=0; node "$SLIM" --report "$RPLOG7" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -Fq '0 with no later json-slim run' "$O" \
   && ! grep -Fq 'gained nothing' "$O"; then ok
else bad R8f-narrowed-followup "rc=$rc out=$(head -c 500 "$O")"; fi
# R8g: the designed low-context recoveries are NOT re-dumps, whatever their saved-bytes delta says: a
# JSONL profile (`profile`), a path handback (`non-json` — its line even logs bytes_out == bytes_in,
# though only a ~120 B path line was printed), a Gate-A capped summary (`spill_out`), and the stream
# refusals (`stream-jq-refused` / `big-nonjsonl`). Only a run that printed the whole file back counts
# (R8e pins that true positive) — the stubbed line's follow-up column obeys the same rule.
RPLOG8="$RPD/low-context-recoveries.log"
cat > "$RPLOG8" <<'RPEOF'
{"ts":"2026-07-25T23:00:00.000Z","project":"elc","lvl":1,"entry":"hook","tool":"mcp__x__dump","decision":"stubbed","reason":"non-json","bytes_in":900000,"bytes_out":900,"pct":99.9,"stages":[],"spill":"/tmp/fnd-mcp-slim-g.json","spills":["/tmp/fnd-mcp-slim-g.json"],"ms":5}
{"ts":"2026-07-25T23:01:00.000Z","project":"elc","lvl":1,"entry":"cli","tool":"/tmp/fnd-mcp-slim-g.json","decision":"passthrough","reason":"stream-profile","profile":true,"bytes_in":900000,"bytes_out":3000,"pct":0,"stages":[],"spill":null,"ms":40}
{"ts":"2026-07-25T23:02:00.000Z","project":"elc","lvl":1,"entry":"cli","tool":"/tmp/page.html","decision":"passthrough","reason":"non-json","format":"html","bytes_in":60013,"bytes_out":60013,"pct":0,"stages":[],"spill":null,"ms":3}
{"ts":"2026-07-25T23:03:00.000Z","project":"elc","lvl":1,"entry":"cli","tool":"/tmp/huge-doc.json","decision":"passthrough","reason":"no-gain","bytes_in":150884,"bytes_out":150884,"pct":0,"stages":[],"spill":null,"spill_out":"/tmp/fnd-slim-out-h.json","ms":12}
{"ts":"2026-07-25T23:04:00.000Z","project":"elc","lvl":1,"entry":"cli","tool":"/tmp/bulk.jsonl","decision":"passthrough","reason":"stream-jq-refused","bytes_in":9000000,"bytes_out":0,"pct":0,"stages":[],"spill":null,"ms":1}
{"ts":"2026-07-25T23:05:00.000Z","project":"elc","lvl":1,"entry":"cli","tool":"/tmp/blob.bin","decision":"passthrough","reason":"big-nonjsonl","bytes_in":9000000,"bytes_out":400,"pct":0,"stages":[],"spill":null,"ms":1}
RPEOF
rc=0; node "$SLIM" --report "$RPLOG8" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && ! grep -Fq 'gained nothing' "$O" \
   && grep -Fq '0 with no later json-slim run' "$O"; then ok
else bad R8g-recoveries-not-flat "rc=$rc out=$(head -c 600 "$O")"; fi

# ---------------------------------------------- json-slim.cjs: CLI telemetry (B4.10a/b) --
# Y1: a CLI run over a crushable file records every spill it wrote in `spills` (the crush file the
# marker points at), keeps `spill_out` for the Gate-A file, and leaves `spill` null (the CLI hands the
# ORIGINAL path back in stdout, it never spills it).
YD="$TMP/cli-telemetry"; mkdir -p "$YD"
YF="$YD/crushable.json"
node -e '
  const rows=Array.from({length:400},(_,i)=>({id:i,status:i%7?"ok":"error",note:"padding-padding-padding-"+i}));
  require("fs").writeFileSync(process.argv[1], JSON.stringify({rows}));
' "$YF"
Y1OUT="$YD/y1"; mkdir -p "$Y1OUT"
rc=0; FND_MCP_SLIM_DIR="$Y1OUT" FND_MCP_SLIM_DEBUG=1 node "$SLIM" "$YF" >"$O" 2>"$E" || rc=$?
Y1LOG="$Y1OUT/fnd-mcp-slim-debug.log"
y1spill="$(jq -r '.spills[]?' "$Y1LOG" 2>/dev/null | head -1)"
if [ "$rc" -eq 0 ] && [ -n "$y1spill" ] && [ -f "$y1spill" ] \
   && printf '%s' "$y1spill" | grep -q 'fnd-crush-' \
   && grep -Fq "full=$y1spill" "$O" \
   && [ "$(jq -r '.spill' "$Y1LOG" 2>/dev/null)" = "null" ]; then ok
else bad Y1-cli-spills "rc=$rc spills=$(jq -c '.spills' "$Y1LOG" 2>/dev/null) out=$(head -c 120 "$O")"; fi

# Y2: Gate A's own spill rides on the same field (so one line answers "what did this run leave on
# disk?"), and `spill_out` keeps naming it for log-schema compatibility.
Y2OUT="$YD/y2"; mkdir -p "$Y2OUT"
rc=0; FND_MCP_SLIM_DIR="$Y2OUT" FND_MCP_SLIM_DEBUG=1 node "$SLIM" "$BIGDOC" >"$O" 2>"$E" || rc=$?
Y2LOG="$Y2OUT/fnd-mcp-slim-debug.log"
y2out="$(jq -r '.spill_out' "$Y2LOG" 2>/dev/null)"
if [ "$rc" -eq 0 ] && [ -n "$y2out" ] && [ "$y2out" != "null" ] \
   && jq -e --arg p "$y2out" '.spills | index($p)' "$Y2LOG" >/dev/null 2>&1; then ok
else bad Y2-gatea-spills "rc=$rc spill_out=$y2out spills=$(jq -c '.spills' "$Y2LOG" 2>/dev/null)"; fi

# Y4 (B4.11): a `--jq` run is flagged `narrowed` on its line. It answered a SUB-PATH, so a zero-reduction
# `--jq` run is a followed recovery, not the whole-file re-dump `--report` counts on the `cli runs:` line;
# a plain run carries no flag (absence is the signal, as with `spills`).
Y4OUT="$YD/y4"; mkdir -p "$Y4OUT"
rc=0; FND_MCP_SLIM_DIR="$Y4OUT" FND_MCP_SLIM_DEBUG=1 node "$SLIM" --jq rows.0.id "$YF" >"$O" 2>"$E" || rc=$?
Y4LOG="$Y4OUT/fnd-mcp-slim-debug.log"
rc2=0; FND_MCP_SLIM_DIR="$Y4OUT" FND_MCP_SLIM_DEBUG=1 node "$SLIM" "$YF" >/dev/null 2>&1 || rc2=$?
y4jq="$(sed -n '1p' "$Y4LOG" | jq -r '.narrowed' 2>/dev/null)"
y4plain="$(sed -n '2p' "$Y4LOG" | jq -r 'has("narrowed")' 2>/dev/null)"
if [ "$rc" -eq 0 ] && [ "$rc2" -eq 0 ] && [ "$y4jq" = "true" ] && [ "$y4plain" = "false" ]; then ok
else bad Y4-cli-narrowed "rc=$rc/$rc2 jq-run=$y4jq plain-run-has-field=$y4plain"; fi

# Y3 (B4.10b): a CLI run from a subdirectory of a repo tags the log line with the REPO's basename, not
# the leaf directory it happened to run in (`scratchpad`/`tmp` in 154 of 476 live events).
Y3REPO="$YD/my-repo"; mkdir -p "$Y3REPO/.git" "$Y3REPO/sub/scratchpad"
Y3OUT="$YD/y3"; mkdir -p "$Y3OUT"
cp "$YF" "$Y3REPO/sub/scratchpad/data.json"
rc=0; (cd "$Y3REPO/sub/scratchpad" && env -u CLAUDE_PROJECT_DIR FND_MCP_SLIM_DIR="$Y3OUT" FND_MCP_SLIM_DEBUG=1 \
  node "$SLIM" data.json) >"$O" 2>"$E" || rc=$?
y3proj="$(jq -r '.project' "$Y3OUT/fnd-mcp-slim-debug.log" 2>/dev/null)"
if [ "$rc" -eq 0 ] && [ "$y3proj" = "my-repo" ]; then ok
else bad Y3-cli-project "rc=$rc project=$y3proj"; fi

echo "scripts-sim: $pass passed, $fail failed"
if [ "$fail" -gt 0 ]; then printf '%s' "$failures"; exit 1; fi
