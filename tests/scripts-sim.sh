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
COMMON="$ROOT/plugins/fnd/scripts/_shopify-common.sh"
WTS_SRC="$ROOT/plugins/fnd/scripts/worktree-setup.sh"
FBC="$ROOT/plugins/fnd/skills/fix-breaking-changes/scripts/fix-breaking-changes.template.js"
BASH_BIN="$(command -v bash)"

TMP="$(mktemp -d)"
# WPID/WPID2 are the port-probe listeners the worktree cases start (see wt_listen). An interrupt
# between `wt_listen` and `wt_unlisten` would otherwise leak a node process holding a 929x port on
# the developer's machine — and the next run of this suite would then be testing around it.
WPID=""; WPID2=""
trap 'for p in "$WPID" "$WPID2"; do [ -n "$p" ] && kill "$p" 2>/dev/null; done; rm -rf "$TMP"' EXIT

# A real ~/.config/domaine/env on this machine would inject switches into every case (the
# scripts under test read it via env-file.cjs / domaine_env) — point the global layer at a
# sandbox. It sits under $TMP so the trap above owns its removal; a PID-suffixed path beside it
# would outlive the run. The EV cases below set their own.
export XDG_CONFIG_HOME="$TMP/xdg"

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
cp "$COMMON" "$TJDIR/"   # sourced from the script's own dir — every fixture copy needs it beside
cat > "$TJDIR/shopify-admin-gql.sh" <<'STUB'
#!/usr/bin/env bash
# stub runner — answers by query content; FAKE_ROLE controls the theme role,
# FAKE_RUNNER_MODE simulates the runner's exit-3 stderr contracts. TJ_GQL_LOG records that the
# runner was reached at all — the --file vetting cases assert the OPPOSITE (nothing was read or
# written), and "no output" alone would also be what a broken stub looks like.
set -u
if [ -n "${TJ_GQL_LOG:-}" ]; then printf 'call\n' >> "$TJ_GQL_LOG"; fi
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
    # the READ-BACK failing on its own after a committed mutation: Admin API throttling right
    # after a write is an ordinary condition, and a 5xx comes back as an HTML body
    throttled) printf '{"errors":[{"message":"Throttled","extensions":{"code":"THROTTLED"}}]}\n'; exit 0 ;;
    gethtml)   printf '<html><body>502 Bad Gateway</body></html>\n'; exit 0 ;;
    # …and the same 5xx on the FIRST read-back only (FAKE_GET_COUNT counts read-backs, since no
    # other query reaches this branch): the retry falls through to the FAKE_BODY_FILE answer
    gethtml1)
      n=1
      if [ -n "${FAKE_GET_COUNT:-}" ]; then
        n=$(( $(cat "$FAKE_GET_COUNT" 2>/dev/null || echo 0) + 1 )); printf '%s' "$n" > "$FAKE_GET_COUNT"
      fi
      [ "$n" -eq 1 ] && { printf '<html><body>502 Bad Gateway</body></html>\n'; exit 0; } ;;
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
# --path/--only are parsed so `theme pull` can materialize a file the way the real CLI does —
# that pull IS the `set` read-back verify. TJ_PULL_BODY (a file) becomes <path>/<only>;
# TJ_PULL_BODY_1 overrides it for the FIRST pull only (the read-after-write race the retry
# covers) and needs TJ_PULL_COUNT, which also records how many pulls a case triggered — the
# only way to assert that FND_THEME_JSON_VERIFY=0 pulls nothing. With no body set the pull
# "succeeds" and produces no file (the unreadable-read-back path). TJ_PUSH_SAVE captures the
# pushed bytes (point TJ_PULL_BODY at it for the round-trip); TJ_PUSH_JSON overrides the
# --json envelope the push prints. TJ_PULL_FAIL makes every pull fail the way a 503 does.
path=""; only=""; prev=""
for a in "$@"; do
  case "$prev" in --path) path="$a" ;; --only) only="$a" ;; esac
  prev="$a"
done
case "$*" in
  *"theme list"*)
    if [ -n "${TJ_LIST_JSON:-}" ]; then printf '%s\n' "$TJ_LIST_JSON"
    else printf '[{"id":2,"name":"Dev","role":"development"}]\n'; fi ;;
  *"theme push"*)
    if [ -n "${TJ_PUSH_SAVE:-}" ] && [ -n "$path" ] && [ -n "$only" ]; then cp "$path/$only" "$TJ_PUSH_SAVE"; fi
    pj="${TJ_PUSH_JSON:-}"; [ -n "$pj" ] || pj='{}'
    printf '%s\n' "$pj" ;;
  *"theme pull"*)
    [ -n "${TJ_PULL_FAIL:-}" ] && { echo "Error: could not pull (503)" >&2; exit 1; }
    n=1
    if [ -n "${TJ_PULL_COUNT:-}" ]; then
      n=$(( $(cat "$TJ_PULL_COUNT" 2>/dev/null || echo 0) + 1 )); printf '%s' "$n" > "$TJ_PULL_COUNT"
    fi
    src="${TJ_PULL_BODY:-}"
    if [ "$n" -eq 1 ] && [ -n "${TJ_PULL_BODY_1:-}" ]; then src="${TJ_PULL_BODY_1}"; fi
    if [ -n "$src" ] && [ -n "$path" ] && [ -n "$only" ]; then
      mkdir -p "$path/$(dirname "$only")"; cp "$src" "$path/$only"
    fi ;;
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
# (TJ_PULL_BODY = the payload: the read-back verify has to find the file it just pushed)
rc=0; M10="$TMP/tj10"; TJ_CLI_MARKER="$M10" FAKE_RUNNER_MODE=nocreds SHOPIFY_CLI_THEME_TOKEN=fake \
  TJ_PULL_BODY="$TMP/snap.json" \
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
# (FAKE_BODY_FILE = the same body, so the read-back verify sees what was written)
printf '%s' '/* auto-generated */
{"current":{"a":1}}' > "$BF/bannered.json"
rc=0; FAKE_BODY_FILE="$BF/bannered.json" "$BASH_BIN" "$TJDIR/theme-json.sh" set --theme 2 --file templates/product.json \
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

# T31 (drift guard): the toml scalar reader has ONE home — a private copy in any of the three theme
# scripts would let them disagree about which store/theme/token a toml resolves to, which is the
# class of bug the shared reader fixes
if [ "$(grep -c '^toml_value() {' "$COMMON")" -eq 1 ] \
   && [ "$(cat "$TJ" "$CPT" "$GQL" "$WTS_SRC" | grep -c '^toml_value() {')" -eq 0 ]; then ok
else bad T31-toml-reader-single-home "toml_value() is defined outside _shopify-common.sh (or missing from it)"; fi
# T31b: the three theme scripts source the lib from their own dir; worktree-setup.sh shares nothing
# with it and stays lib-free (it derives nothing from $0 by design)
if grep -q '^\. "\$SCRIPT_DIR/_shopify-common\.sh"$' "$TJ" && grep -q '^\. "\$SCRIPT_DIR/_shopify-common\.sh"$' "$CPT" \
   && grep -q '^\. "\$SCRIPT_DIR/_shopify-common\.sh"$' "$GQL" && ! grep -q '_shopify-common' "$WTS_SRC"; then ok
else bad T31b-common-lib-sourced "expected cpt/tj/gql to source _shopify-common.sh and worktree-setup.sh not to"; fi
# T31c: the sourcing is real, not vacuous — a copy without the lib beside it stops with its own
# error= line (exit 2 on the stderr scripts) before any engine runs
LONE="$TMP/lone"; mkdir -p "$LONE"; cp "$TJ" "$LONE/theme-json.sh"; cp "$GQL" "$LONE/shopify-admin-gql.sh"
rc=0; "$BASH_BIN" "$LONE/theme-json.sh" themes >"$O" 2>"$E" || rc=$?
assert T31c-tj-common-lib-missing 2 "$rc" "$E" "error=common_lib_not_found path=$LONE/_shopify-common.sh"
rc=0; "$BASH_BIN" "$LONE/shopify-admin-gql.sh" --query "$TJDIR/theme-json.sh" >"$O" 2>"$E" || rc=$?
assert T31d-gql-common-lib-missing 2 "$rc" "$E" "error=common_lib_not_found path=$LONE/_shopify-common.sh"

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
# The themecli engine probes `command -v shopify` before it ever reads the toml, so the case
# needs a CLI on PATH to reach the read at all; the stub must never actually run — the no-store
# refusal comes first — so it exits 99 to fail the case loudly if it ever does.
T33SHIM="$TMP/t33-shim"; mkdir -p "$T33SHIM"
printf '#!/bin/sh\nexit 99\n' > "$T33SHIM/shopify"; chmod +x "$T33SHIM/shopify"
rc=0; TOML_PATH="$UT33" PATH="$T33SHIM:$PATH" "$BASH_BIN" "$TJ" themes --engine themecli >"$O" 2>"$E" || rc=$?
chmod 644 "$UT33"
if [ "$rc" -eq 2 ] && grep -q 'error=no_store' "$E" && ! grep -qi "awk: can't open" "$E"; then ok
else bad T33-unreadable-toml-no-store "rc=$rc err=$(head -c 160 "$E" | tr '\n' ' ')"; fi

# --- `set` read-back verify: Shopify keeps the PREVIOUS content for payloads it rejects
# server-side while the write reports success — push exit 0, no userErrors. Every case
# below drives that divergence through the stubs; the themecli set runs with --engine themecli so
# the gql stub is out of the picture. FND_THEME_JSON_VERIFY_WAIT=0 keeps every retrying case from
# paying the pause before the second read-back (2 s each at the default) — T47 is the one row
# that pays it, because it is the row about the fallback.
export FND_THEME_JSON_VERIFY_WAIT=0
TV="$TMP/tjverify"; mkdir -p "$TV"
printf '%s' '{"sections":{"main":{"settings":{"test_parent":"{{ product.metafields.a.b.value }}"}}}}' > "$TV/new.json"
printf '%s' '{"sections":{"main":{"settings":{"test_parent":"old"}}}}' > "$TV/old.json"
tj_set_cli() { # tj_set_cli <from> — themecli `set`, caller sets the TJ_PULL_* fixture vars
  SHOPIFY_CLI_THEME_TOKEN=fake PATH="$TJSHIM:$PATH" \
    "$BASH_BIN" "$TJDIR/theme-json.sh" set --engine themecli --store test.myshopify.com \
    --theme 2 --file templates/product.json --from "$1"
}

# T34: the pull-back returns exactly what was pushed → the existing success line, now carrying
# verified=true (TJ_PUSH_SAVE→TJ_PULL_BODY makes the stub a real round-trip, not a fixture echo)
rc=0; TJ_PUSH_SAVE="$TV/pushed.json" TJ_PULL_BODY="$TV/pushed.json" \
  tj_set_cli "$TV/new.json" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -q '"ok":"upserted"' "$O" && grep -q '"verified":"true"' "$O" \
   && cmp -s "$TV/pushed.json" "$TV/new.json"; then ok
else bad T34-cli-verified "rc=$rc out=$(head -c 160 "$O") err=$(head -c 160 "$E" | tr '\n' ' ')"; fi

# T35 (bug): the theme still serves the old content on BOTH attempts — the false ok=upserted this
# whole section exists for. The error line is stdout (the caller's channel), the fix hint stderr,
# and the two known triggers are named — including the canonical `{{ ….value }}` form.
rc=0; C35="$TMP/tj35-pulls"; : > "$C35"
TJ_PULL_BODY="$TV/old.json" TJ_PULL_COUNT="$C35" tj_set_cli "$TV/new.json" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 6 ] && grep -q 'error=not_applied engine=themecli theme=2 file=templates/product.json' "$O" \
   && ! grep -q 'ok":"upserted' "$O"; then ok
else bad T35-cli-not-applied "rc=$rc out=$(head -c 200 "$O")"; fi
if grep -qF '.value' "$E" && grep -q 'hint=' "$E" && grep -qi 'previous content' "$E"; then ok
else bad T35b-hint-names-triggers "err=$(head -c 300 "$E" | tr '\n' ' ')"; fi
# T35d (bug): the hint may not ASSERT the pre-image — nothing is read before the write, so
# "the old content is still in place" is a claim the script cannot make, and a caller that
# believes it skips the restore step on a theme that may well have changed.
if grep -q 'get --theme 2 --file templates/product.json' "$E" \
   && ! grep -qi 'old content is still in place' "$E"; then ok
else bad T35d-hint-no-preimage-claim "err=$(head -c 400 "$E" | tr '\n' ' ')"; fi
if [ "$(cat "$C35")" = 2 ]; then ok; else bad T35c-retried-once "pulls=$(cat "$C35") want 2"; fi

# T36 (race guard): a read issued right after a write can still be served the old copy — the
# FIRST pull-back is stale, the retry sees the payload, and the set succeeds
rc=0; C36="$TMP/tj36-pulls"; : > "$C36"
TJ_PULL_BODY_1="$TV/old.json" TJ_PULL_BODY="$TV/new.json" TJ_PULL_COUNT="$C36" \
  tj_set_cli "$TV/new.json" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -q '"verified":"true"' "$O" && [ "$(cat "$C36")" = 2 ]; then ok
else bad T36-retry-then-success "rc=$rc pulls=$(cat "$C36") out=$(head -c 160 "$O")"; fi

# T37 (bug): Shopify re-stamps its /*…*/ banner and reserializes the JSON on every write, so a raw
# byte compare would report not_applied on every single successful set. Same content, different
# banner + key order + whitespace → verified.
printf '%s' '{"b":2,"a":{"y":1,"x":2}}' > "$TV/payload.json"
printf '%s' '/* This file is auto-generated — do not edit */
{
  "a": { "x": 2, "y": 1 },
  "b": 2
}' > "$TV/reserialized.json"
rc=0; TJ_PULL_BODY="$TV/reserialized.json" tj_set_cli "$TV/payload.json" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -q '"verified":"true"' "$O" \
   && ! cmp -s "$TV/payload.json" "$TV/reserialized.json"; then ok
else bad T37-banner-keyorder-normalized "rc=$rc out=$(head -c 160 "$O") err=$(head -c 160 "$E" | tr '\n' ' ')"; fi

# T38 (escape hatch): FND_THEME_JSON_VERIFY=0 does no read-back at all — the pull-back fixture is
# the stale content, which would otherwise fail the case, and no pull is recorded
rc=0; C38="$TMP/tj38-pulls"; : > "$C38"
FND_THEME_JSON_VERIFY=0 TJ_PULL_BODY="$TV/old.json" TJ_PULL_COUNT="$C38" \
  tj_set_cli "$TV/new.json" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -q '"verified":"skipped"' "$O" && [ ! -s "$C38" ]; then ok
else bad T38-verify-off "rc=$rc pulls=$(cat "$C38") out=$(head -c 160 "$O")"; fi

# T39 (bug): the push's --json envelope was captured and never read. An envelope reporting errors
# despite exit 0 fails before the read-back — nothing to verify, the file did not go up.
rc=0; C39="$TMP/tj39-pulls"; : > "$C39"
TJ_PUSH_JSON='{"errors":["templates/product.json: Invalid schema attribute"]}' \
  TJ_PULL_BODY="$TV/new.json" TJ_PULL_COUNT="$C39" tj_set_cli "$TV/new.json" >"$O" 2>"$E" || rc=$?
assert T39-push-json-errors 5 "$rc" "$E" "error=cli_push_reported_errors"
if [ ! -s "$C39" ] && [ ! -s "$O" ]; then ok
else bad T39b-no-readback-after-errors "pulls=$(cat "$C39") out=$(head -c 120 "$O")"; fi
# T39c: exiting before the read-back leaves the theme's state as unconfirmed as an exit 6 does —
# the caller gets the same `get` hint, or it learns nothing about where the theme now stands
if grep -q 'hint=.*get --theme 2 --file templates/product.json' "$E"; then ok
else bad T39c-errors-recovery-hint "err=$(head -c 300 "$E" | tr '\n' ' ')"; fi

# T40: gql mirror of T34 — themeFilesUpsert returning no userErrors is not proof either, so the
# same read-back runs there (the stub's FndThemeFileGet answers with FAKE_BODY_FILE)
rc=0; FAKE_BODY_FILE="$TV/new.json" "$BASH_BIN" "$TJDIR/theme-json.sh" set --theme 2 \
  --file templates/product.json --from "$TV/new.json" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -q '"engine":"gql"' "$O" && grep -q '"verified":"true"' "$O"; then ok
else bad T40-gql-verified "rc=$rc out=$(head -c 160 "$O") err=$(head -c 160 "$E" | tr '\n' ' ')"; fi

# T41: gql mirror of T35 — read-back returns the old content, same contract with engine=gql
rc=0; FAKE_BODY_FILE="$TV/old.json" "$BASH_BIN" "$TJDIR/theme-json.sh" set --theme 2 \
  --file templates/product.json --from "$TV/new.json" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 6 ] && grep -q 'error=not_applied engine=gql theme=gid://shopify/OnlineStoreTheme/2 file=templates/product.json' "$O" \
   && grep -qF '.value' "$E"; then ok
else bad T41-gql-not-applied "rc=$rc out=$(head -c 200 "$O") err=$(head -c 200 "$E" | tr '\n' ' ')"; fi

# T42 (degradation): the normalizer needs perl to strip the banner, and the `set` json guard
# already degrades instead of refusing when perl is missing — the verify does the same, comparing
# raw bytes and saying so on stderr. A PATH of symlinks to exactly the tools the script uses is
# the only way to make `command -v perl` fail on a normal machine.
NOPERL="$TMP/noperl-bin"; mkdir -p "$NOPERL"
for b in jq mktemp cmp cat sed tr wc grep awk dirname mkdir head tail cp sleep rm touch bash; do
  p="$(command -v "$b" 2>/dev/null)" && ln -sf "$p" "$NOPERL/$b"
done
rc=0; SHOPIFY_CLI_THEME_TOKEN=fake TJ_PULL_BODY="$TV/new.json" PATH="$TJSHIM:$NOPERL" \
  "$BASH_BIN" "$TJDIR/theme-json.sh" set --engine themecli --store test.myshopify.com \
  --theme 2 --file templates/product.json --from "$TV/new.json" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -q '"verified":"true"' "$O" && grep -q 'note=verify_raw_compare' "$E"; then ok
else bad T42-no-perl-raw-compare "rc=$rc out=$(head -c 160 "$O") err=$(head -c 200 "$E" | tr '\n' ' ')"; fi

# T43 (bug): the degradation above must not be fail-CLOSED. Shopify re-stamps the banner and
# reserializes on EVERY successful write, so on a perl-less host the raw compare differs for
# every real `set` — reporting that as not_applied + exit 6 would make the escape hatch
# (FND_THEME_JSON_VERIFY=0) the only way to work, restoring the very false success this exists
# to kill. A raw MISMATCH is `verified=unverified` + exit 0 instead, said on stderr.
rc=0; SHOPIFY_CLI_THEME_TOKEN=fake TJ_PULL_BODY="$TV/reserialized.json" PATH="$TJSHIM:$NOPERL" \
  "$BASH_BIN" "$TJDIR/theme-json.sh" set --engine themecli --store test.myshopify.com \
  --theme 2 --file templates/product.json --from "$TV/payload.json" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -q '"ok":"upserted"' "$O" && grep -q '"verified":"unverified"' "$O" \
   && grep -q 'note=verify_unverified' "$E" && ! grep -q 'error=not_applied' "$O"; then ok
else bad T43-no-perl-mismatch-fails-open "rc=$rc out=$(head -c 200 "$O") err=$(head -c 240 "$E" | tr '\n' ' ')"; fi

# T44 (bug): the note was gated on `command -v perl` FAILING, so a perl that EXISTS but errors
# degraded to the same raw compare with an empty note channel — nothing pointing at the cause.
PERLFAIL="$TMP/perlfail-bin"; mkdir -p "$PERLFAIL"
printf '#!/bin/sh\nexit 9\n' > "$PERLFAIL/perl"; chmod +x "$PERLFAIL/perl"
rc=0; SHOPIFY_CLI_THEME_TOKEN=fake TJ_PULL_BODY="$TV/reserialized.json" PATH="$PERLFAIL:$TJSHIM:$PATH" \
  "$BASH_BIN" "$TJDIR/theme-json.sh" set --engine themecli --store test.myshopify.com \
  --theme 2 --file templates/product.json --from "$TV/payload.json" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -q '"verified":"unverified"' "$O" && grep -q 'note=verify_raw_compare' "$E"; then ok
else bad T44-broken-perl-notes-it "rc=$rc out=$(head -c 200 "$O") err=$(head -c 240 "$E" | tr '\n' ' ')"; fi

# T45: a `set` on a NON-json file used to reach the raw-bytes half of the verify compare; the
# writable set is now the JSON content layer alone (T48 owns that gate), so the refusal is what
# this pair pins instead — including the one property the old case cared about, that a write which
# never reached the store cannot be reported as a landed one.
printf '%s' 'a{{ x }}b' > "$TV/snippet.liquid"
rc=0; M45="$TMP/tj45"; SHOPIFY_CLI_THEME_TOKEN=fake TJ_CLI_MARKER="$M45" PATH="$TJSHIM:$PATH" \
  "$BASH_BIN" "$TJDIR/theme-json.sh" set --engine themecli --store test.myshopify.com \
  --theme 2 --file sections/x.liquid --from "$TV/snippet.liquid" >"$O" 2>"$E" || rc=$?
assert T45-liquid-set-refused 2 "$rc" "$E" "error=file_not_writable"
if [ ! -e "$M45" ] && ! grep -q 'verified' "$O"; then ok
else bad T45b-liquid-no-push "the theme CLI ran or a verdict was printed: out=$(head -c 200 "$O")"; fi

# T46 (bug): a gql read-back that fails on its own — Shopify throttling right after the
# committed mutation — used to exit 5 with `error=gql_errors` from INSIDE the read-back: output
# byte-identical to "the upsert failed", for a write that already went through. It is a read
# failure: error=verify_read_failed + exit 6, after the same retry.
rc=0; FAKE_GET_MODE=throttled "$BASH_BIN" "$TJDIR/theme-json.sh" set --theme 2 \
  --file templates/product.json --from "$TV/new.json" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 6 ] && grep -q 'error=verify_read_failed engine=gql' "$O" \
   && ! grep -q 'error=gql_errors' "$O" && ! grep -q '"ok":"upserted"' "$O"; then ok
else bad T46-gql-readback-throttled "rc=$rc out=$(head -c 200 "$O") err=$(head -c 200 "$E" | tr '\n' ' ')"; fi
# same for a non-JSON (5xx HTML) read-back body
rc=0; FAKE_GET_MODE=gethtml "$BASH_BIN" "$TJDIR/theme-json.sh" set --theme 2 \
  --file templates/product.json --from "$TV/new.json" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 6 ] && grep -q 'error=verify_read_failed engine=gql' "$O"; then ok
else bad T46b-gql-readback-non-json "rc=$rc out=$(head -c 200 "$O") err=$(head -c 200 "$E" | tr '\n' ' ')"; fi

# T46c (bug): the SAME transient 5xx on the first read-back and the payload on the retry — a run
# that ends verified + exit 0. The non-JSON branch used to print `error=non_json_response log=…`
# + 600 bytes of body BEFORE it looked at the soft-read flag, so a healthy `set` came back with an
# `error=` line on its stderr (byte-identical to a failed upsert) and a $TMPDIR log nobody reaps.
GT="$TMP/tj46c-tmp"; mkdir -p "$GT"; C46="$TMP/tj46c-gets"; : > "$C46"
rc=0; TMPDIR="$GT" FAKE_GET_MODE=gethtml1 FAKE_GET_COUNT="$C46" FAKE_BODY_FILE="$TV/new.json" \
  "$BASH_BIN" "$TJDIR/theme-json.sh" set --theme 2 --file templates/product.json \
  --from "$TV/new.json" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -q '"verified":"true"' "$O" && [ "$(cat "$C46")" = 2 ]; then ok
else bad T46c-gql-readback-retry "rc=$rc gets=$(cat "$C46") out=$(head -c 200 "$O") err=$(head -c 200 "$E" | tr '\n' ' ')"; fi
if ! grep -q 'error=' "$E"; then ok
else bad T46d-no-error-token "a verified run printed an error= line: $(head -c 240 "$E" | tr '\n' ' ')"; fi
if [ -z "$(ls -A "$GT" 2>/dev/null)" ]; then ok
else bad T46e-no-leaked-log "the soft read-back left files in TMPDIR: $(ls -A "$GT" | tr '\n' ' ')"; fi

# T47 (bug): the read-back BODY not parsing as JSON is not the same fact as "this host cannot
# normalize". The payload is validated as JSON before the upload, so a theme serving a non-JSON
# body is a theme not serving the payload — a mismatch, not a fail-open. It used to raise the
# same flag as a missing perl and come back `verified=unverified` + exit 0, i.e. the false
# success this whole section exists to kill, on a host that could have told the truth.
printf '%s' '<html><body>Shopify was unhappy</body></html>' > "$TV/garbled.json"
rc=0; TJ_PULL_BODY="$TV/garbled.json" tj_set_cli "$TV/new.json" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 6 ] && grep -q 'error=not_applied engine=themecli' "$O" \
   && grep -q 'note=verify_body_not_json' "$E" && ! grep -q '"verified":"unverified"' "$O"; then ok
else bad T47-body-not-json-is-mismatch "rc=$rc out=$(head -c 200 "$O") err=$(head -c 240 "$E" | tr '\n' ' ')"; fi
# T47b (bug): and that verdict is per ATTEMPT. The flag was sticky for the whole run, so one
# garbled first read poisoned a clean, MATCHING second one into `unverified`.
rc=0; C47="$TMP/tj47-pulls"; : > "$C47"
TJ_PUSH_SAVE="$TV/pushed47.json" TJ_PULL_BODY_1="$TV/garbled.json" TJ_PULL_BODY="$TV/pushed47.json" \
  TJ_PULL_COUNT="$C47" tj_set_cli "$TV/new.json" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -q '"verified":"true"' "$O" && [ "$(cat "$C47")" = 2 ]; then ok
else bad T47b-garbled-then-clean "rc=$rc pulls=$(cat "$C47") out=$(head -c 200 "$O") err=$(head -c 240 "$E" | tr '\n' ' ')"; fi
# T47c: an unusable FND_THEME_JSON_VERIFY_WAIT falls back to the default instead of handing
# `sleep` an argument it refuses — under `set -e` that would abort the verify mid-run. This is
# the one row in the section that pays the pause.
rc=0; FND_THEME_JSON_VERIFY_WAIT=soon TJ_PULL_BODY="$TV/old.json" tj_set_cli "$TV/new.json" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 6 ] && grep -q 'error=not_applied' "$O" && ! grep -qi 'sleep' "$E"; then ok
else bad T47c-invalid-wait "rc=$rc out=$(head -c 200 "$O") err=$(head -c 240 "$E" | tr '\n' ' ')"; fi
# T47d: `1.2.3` is the shape a bytes-only filter lets through — `sleep` still refuses it, and under
# `set -e` that aborted the verify AFTER the mutation had committed, stranding the caller with no
# verdict at all. It must fall back like any other unusable value.
rc=0; FND_THEME_JSON_VERIFY_WAIT=1.2.3 TJ_PULL_BODY="$TV/old.json" tj_set_cli "$TV/new.json" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 6 ] && grep -q 'error=not_applied' "$O" && ! grep -qi 'sleep' "$E"; then ok
else bad T47d-multidot-wait "rc=$rc out=$(head -c 200 "$O") err=$(head -c 240 "$E" | tr '\n' ' ')"; fi
# T50 (bug): the themecli live guard used to compare the role against the exact lowercase `live`
# only; it now shares create-preview-theme.sh's rule (live|main, any case). No push reaches the CLI.
rc=0; L="$TMP/tjl50"; : > "$L"
TJ_CLI_LOG="$L" TJ_LIST_JSON='[{"id":2,"name":"Live","role":"live"}]' tj_set_cli "$TV/new.json" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 4 ] && grep -q 'error=live_theme_write_refused' "$E" && ! grep -q 'argv=theme push' "$L"; then ok
else bad T50-cli-set-live-refused "rc=$rc err=$(head -c 160 "$E" | tr '\n' ' ') log=$(tr '\n' ';' < "$L")"; fi
# T50b: the GraphQL enum spelling, upper-case
rc=0; L="$TMP/tjl50b"; : > "$L"
TJ_CLI_LOG="$L" TJ_LIST_JSON='[{"id":2,"name":"Live","role":"MAIN"}]' tj_set_cli "$TV/new.json" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 4 ] && grep -q 'error=live_theme_write_refused' "$E" && ! grep -q 'argv=theme push' "$L"; then ok
else bad T50b-cli-set-main-refused "rc=$rc err=$(head -c 160 "$E" | tr '\n' ' ') log=$(tr '\n' ';' < "$L")"; fi
# T50c: an id the listing does not carry is theme_not_found …
rc=0; TJ_LIST_JSON='[{"id":9,"name":"Other","role":"development"}]' tj_set_cli "$TV/new.json" >"$O" 2>"$E" || rc=$?
assert T50c-cli-set-not-listed 5 "$rc" "$E" "error=theme_not_found theme=2 (engine=themecli)"
# T50d: … while a LISTED theme with no role is a list-shape drift — refused as unreadable, never
# "not found" and never waved through (a literal jq `null` used to pass the emptiness check)
rc=0; L="$TMP/tjl50d"; : > "$L"
TJ_CLI_LOG="$L" TJ_LIST_JSON='[{"id":2,"name":"Dev"}]' tj_set_cli "$TV/new.json" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 5 ] && grep -q 'error=live_role_unreadable theme=2 (engine=themecli)' "$E" && ! grep -q 'argv=theme push' "$L"; then ok
else bad T50d-cli-set-roleless "rc=$rc err=$(head -c 160 "$E" | tr '\n' ' ') log=$(tr '\n' ';' < "$L")"; fi

# T51 (bug): a CLI upgrade banner before the listing JSON used to kill every themecli `themes` and
# `set` with cli_list_failed — the shared trim (the one create-preview-theme.sh always had) drops it
TJ_BANNER_LIST='Upgrade available: run `npm i -g @shopify/cli`
[{"id":2,"name":"Dev","role":"development"}]'
rc=0; TJ_LIST_JSON="$TJ_BANNER_LIST" SHOPIFY_CLI_THEME_TOKEN=fake PATH="$TJSHIM:$PATH" \
  "$BASH_BIN" "$TJDIR/theme-json.sh" themes --engine themecli --store test.myshopify.com >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -q '"name":"Dev"' "$O" && grep -q '"role":"DEVELOPMENT"' "$O"; then ok
else bad T51-cli-list-banner "rc=$rc out=$(head -c 160 "$O") err=$(head -c 160 "$E" | tr '\n' ' ')"; fi
# T51b: the same banner on the `set` path — the role read still finds the theme and the write lands
rc=0; TJ_LIST_JSON="$TJ_BANNER_LIST" TJ_PUSH_SAVE="$TV/pushed51.json" TJ_PULL_BODY="$TV/pushed51.json" \
  tj_set_cli "$TV/new.json" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -q '"ok":"upserted"' "$O" && grep -q '"verified":"true"' "$O"; then ok
else bad T51b-cli-list-banner-set "rc=$rc out=$(head -c 160 "$O") err=$(head -c 160 "$E" | tr '\n' ' ')"; fi
# T51c: an EMPTY listing is a failed listing, not "no themes" — `jq empty` accepts no input, so
# without this gate a silent CLI read as theme_not_found by accident
rc=0; TJ_LIST_JSON=' ' SHOPIFY_CLI_THEME_TOKEN=fake PATH="$TJSHIM:$PATH" \
  "$BASH_BIN" "$TJDIR/theme-json.sh" themes --engine themecli --store test.myshopify.com >"$O" 2>"$E" || rc=$?
assert T51c-cli-list-empty 5 "$rc" "$E" "error=cli_list_failed"
rc=0; TJ_LIST_JSON=' ' tj_set_cli "$TV/new.json" >"$O" 2>"$E" || rc=$?
assert T51d-cli-list-empty-set 5 "$rc" "$E" "error=cli_list_failed"
unset FND_THEME_JSON_VERIFY_WAIT

# T49: themecli `get` — a pull of exactly the named file into a private dir, whose body reaches
# stdout through the same emit_file the gql engine uses (every earlier `get` case ran the stub runner)
tj_get_cli() { # tj_get_cli <log> <args…> — themecli `get --theme 2 --file templates/product.json`
  local log="$1"; shift
  TJ_CLI_LOG="$log" SHOPIFY_CLI_THEME_TOKEN=fake PATH="$TJSHIM:$PATH" \
    "$BASH_BIN" "$TJDIR/theme-json.sh" get --engine themecli --store test.myshopify.com \
    --theme 2 --file templates/product.json "$@"
}
L="$TMP/tj49.log"; : > "$L"
rc=0; TJ_PULL_BODY="$TMP/snap.json" tj_get_cli "$L" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ "$(head -1 "$O")" = '{"a":1}' ] \
   && grep -q 'argv=theme pull --store test.myshopify.com --theme 2 --path .* --only templates/product.json --nodelete' "$L" \
   && ! grep -q 'theme list' "$L"; then ok
else bad T49-cli-get-body "rc=$rc out=$(head -c 120 "$O") err=$(head -c 160 "$E" | tr '\n' ' ') log=$(tr '\n' ';' < "$L")"; fi
# T49b: --out lands the exact bytes and reports on stderr, the snapshot contract `set` restores from
rc=0; TJ_PULL_BODY="$TMP/snap.json" tj_get_cli /dev/null --out "$TMP/snap-cli.json" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && cmp -s "$TMP/snap-cli.json" "$TMP/snap.json" && [ ! -s "$O" ] \
   && grep -q "^ok=saved file=templates/product.json out=$TMP/snap-cli.json bytes=" "$E"; then ok
else bad T49b-cli-get-out "rc=$rc out=$(head -c 120 "$O") err=$(head -c 160 "$E" | tr '\n' ' ')"; fi
# T49c: a pull that succeeds without producing the file is file_not_found on this engine (the CLI
# exits 0 for an --only pattern that matches nothing)
rc=0; tj_get_cli /dev/null >"$O" 2>"$E" || rc=$?
assert T49c-cli-get-missing 5 "$rc" "$E" "error=file_not_found file=templates/product.json theme=2 (engine=themecli)"
# T49d: a failed pull is cli_pull_failed with the CLI's stderr tail, never an empty body
rc=0; TJ_PULL_FAIL=1 tj_get_cli /dev/null >"$O" 2>"$E" || rc=$?
assert T49d-cli-get-pull-failed 5 "$rc" "$E" "error=cli_pull_failed theme=2"
if grep -q 'could not pull (503)' "$E" && [ ! -s "$O" ]; then ok
else bad T49d-cli-get-pull-failed-tail "err=$(head -c 160 "$E" | tr '\n' ' ') out=$(head -c 80 "$O")"; fi

# T48: --file vetting. `--file` names a path INSIDE the theme, but themecli materializes it under
# a mktemp dir (`cp "$FROM" "$tmp/$FILE"`), so a `../` used to escape onto the local filesystem —
# and on BOTH engines a `set --file assets/… --from ~/.ssh/id_rsa` published a local secret on the
# theme's public CDN. The gate runs at dispatch, before any engine, which is what the
# runner/CLI-untouched half of each case pins: a refusal that already spoke to the store is not a
# refusal. TJ_GQL_LOG only ever records the gql runner being REACHED, never a query.
TJV="$TMP/tjvet"; mkdir -p "$TJV"
tjv_run() { # <label> <want-rc> <stderr-key> — rest is the theme-json.sh argv
  local label="$1" want="$2" key="$3"; shift 3
  local g="$TJV/gql.log" m="$TJV/cli.marker" rc=0
  : > "$g"; rm -f "$m"
  TJ_GQL_LOG="$g" TJ_CLI_MARKER="$m" SHOPIFY_CLI_THEME_TOKEN=fake TJ_PULL_BODY="$TMP/snap.json" \
    PATH="$TJSHIM:$PATH" "$BASH_BIN" "$TJDIR/theme-json.sh" "$@" \
    --store test.myshopify.com >"$O" 2>"$E" || rc=$?
  if [ "$want" -eq 0 ]; then   # the accepted shapes print their verdict on stdout, not stderr
    if [ "$rc" -eq 0 ] && grep -q "$key" "$O"; then ok
    else bad "$label" "rc=$rc out=$(head -c 160 "$O") err=$(head -c 200 "$E" | tr '\n' ' ')"; fi
    return 0
  fi
  assert "$label" "$want" "$rc" "$E" "$key"
  if [ ! -s "$g" ] && [ ! -e "$m" ]; then ok
  else bad "$label-no-engine" "an engine ran before the refusal: gql=$(wc -l < "$g" | tr -d ' ') cli=$([ -e "$m" ] && echo yes || echo no)"; fi
}
tjv_run T48a-get-traversal      2 error=bad_file get --theme 2 --file ../../x.json
tjv_run T48b-get-inner-dotdot   2 error=bad_file get --theme 2 --file templates/../../x.json
tjv_run T48c-get-absolute       2 error=bad_file get --theme 2 --file /etc/passwd
tjv_run T48d-get-empty-segment  2 error=bad_file get --theme 2 --file templates//a.json
tjv_run T48e-get-foreign-dir    2 error=bad_file get --theme 2 --file .git/config
tjv_run T48f-set-traversal      2 error=bad_file set --theme 2 --file ../../x.json --from "$TMP/snap.json"
# `set` narrows further: an asset is served from the theme's PUBLIC CDN, so the JSON content layer
# is the whole writable set — and the refusal names the CLI to use instead.
tjv_run T48g-set-asset          2 error=file_not_writable set --theme 2 --file assets/leak.txt --from "$TMP/snap.json"
tjv_run T48h-set-liquid         2 error=file_not_writable set --theme 2 --file snippets/x.liquid --from "$TMP/snap.json"
tjv_run T48i-set-nested-config  2 error=file_not_writable set --theme 2 --file config/sub/settings_data.json --from "$TMP/snap.json"
# …while the shapes the script exists for still go through, at any depth under templates/
tjv_run T48j-set-nested-template 0 '"ok":"upserted"' set --theme 2 --file templates/customers/account.json --from "$TMP/snap.json"
tjv_run T48k-set-section-group   0 '"ok":"upserted"' set --theme 2 --file sections/header-group.json --from "$TMP/snap.json"
# `get` keeps the broader read set — the same top-level dirs, JSON or not (nothing leaves the store
# on a read, and inspecting a rendered asset is a legitimate use)
rc=0; TJ_GQL_LOG="$TJV/gql.log" "$BASH_BIN" "$TJDIR/theme-json.sh" get --theme 2 --file assets/app.js \
  --store test.myshopify.com >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ "$(head -1 "$O")" = '{"a":1}' ]; then ok
else bad T48l-get-asset-allowed "rc=$rc out=$(head -c 120 "$O") err=$(head -c 200 "$E" | tr '\n' ' ')"; fi
# --from vetting: whatever it names is what gets published, so the credential files an agent might
# reach for by name are refused before the upload (a deny list, not a sandbox)
FAKEHOME="$TMP/tjvet-home"; mkdir -p "$FAKEHOME/.ssh"
printf -- '-----BEGIN OPENSSH PRIVATE KEY-----\n' > "$FAKEHOME/.ssh/id_rsa"
tjv_run T48m-from-ssh-key 2 error=from_file_refused \
  set --theme 2 --file templates/product.json --from "$FAKEHOME/.ssh/id_rsa"
printf '{"a":1}\n' > "$FAKEHOME/.env.local"
tjv_run T48n-from-dotenv 2 error=from_file_refused \
  set --theme 2 --file templates/product.json --from "$FAKEHOME/.env.local"
# …and the deny list matches a RESOLVED path, not the string the caller typed: an agent whose cwd
# is $HOME names `.aws/credentials` with no leading slash, and a symlink hides the name entirely.
tjv_from_at() { # <label> <want-rc> <stderr-key> <cwd> — rest is the theme-json.sh argv
  local label="$1" want="$2" key="$3" dir="$4"; shift 4
  local g="$TJV/gql.log" m="$TJV/cli.marker" rc=0
  : > "$g"; rm -f "$m"
  ( cd "$dir" && TJ_GQL_LOG="$g" TJ_CLI_MARKER="$m" SHOPIFY_CLI_THEME_TOKEN=fake \
      TJ_PULL_BODY="$TMP/snap.json" PATH="$TJSHIM:$PATH" \
      "$BASH_BIN" "$TJDIR/theme-json.sh" "$@" --store test.myshopify.com ) >"$O" 2>"$E" || rc=$?
  if [ "$want" -eq 0 ]; then
    if [ "$rc" -eq 0 ] && grep -q "$key" "$O"; then ok
    else bad "$label" "rc=$rc out=$(head -c 160 "$O") err=$(head -c 200 "$E" | tr '\n' ' ')"; fi
    return 0
  fi
  assert "$label" "$want" "$rc" "$E" "$key"
  if [ ! -s "$g" ] && [ ! -e "$m" ]; then ok
  else bad "$label-no-engine" "an engine ran before the refusal: gql=$(wc -l < "$g" | tr -d ' ') cli=$([ -e "$m" ] && echo yes || echo no)"; fi
}
mkdir -p "$FAKEHOME/.aws"
printf 'aws_secret_access_key = s3cret\n' > "$FAKEHOME/.aws/credentials"
tjv_from_at T48o-from-relative-creds 2 error=from_file_refused "$FAKEHOME" \
  set --theme 2 --file templates/product.json --from .aws/credentials
# the target is VALID JSON (an SSO token cache), so only the deny list can be what refuses it
mkdir -p "$FAKEHOME/.aws/sso"
printf '{"accessToken":"s3cret"}\n' > "$FAKEHOME/.aws/sso/cache.json"
ln -sf .aws/sso/cache.json "$FAKEHOME/ok.json"
tjv_from_at T48p-from-symlink 2 error=from_file_refused "$FAKEHOME" \
  set --theme 2 --file templates/product.json --from ok.json
# …and a chain of links reaches the same bytes through an innocent middle name
ln -sf ok.json "$FAKEHOME/mid.json"
ln -sf mid.json "$FAKEHOME/chain.json"
tjv_from_at T48p2-from-symlink-chain 2 error=from_file_refused "$FAKEHOME" \
  set --theme 2 --file templates/product.json --from chain.json
# a plain relative --from is still the ordinary case and goes through
cp "$TMP/snap.json" "$FAKEHOME/good.json"
tjv_from_at T48q-from-relative-ok 0 '"ok":"upserted"' "$FAKEHOME" \
  set --theme 2 --file templates/product.json --from good.json

# ------------------------------------- shopify-admin-gql.sh against PATH shims --
SHIM="$TMP/shim"; mkdir -p "$SHIM"
GQLDIR="$TMP/gqlwork"; mkdir -p "$GQLDIR"
printf 'mutation FndX { thingCreate { id } }\n' > "$GQLDIR/mutation.graphql"
printf 'query FndY { shop { name } }\n' > "$GQLDIR/query.graphql"
printf '{"k":"v"}\n' > "$GQLDIR/vars.json"
# a multi-operation document: --operation must carve out ONE named block plus every fragment
printf 'query FndA {\n  shop { ...F }\n}\n\nmutation FndB {\n  thingCreate { id }\n}\n\nfragment F on Shop {\n  name\n}\n' > "$GQLDIR/multi.graphql"

cat > "$SHIM/shopify" <<'FAKE'
#!/usr/bin/env bash
# $SHOPIFY_LOG counts invocations (one argv line each) — the only way to assert that the
# version probe and the doomed `store execute` were NOT paid a second time.
[ -n "${SHOPIFY_LOG:-}" ] && printf '%s\n' "$*" >> "$SHOPIFY_LOG"
# FAKE_VERSION set-but-EMPTY is its own fixture (a CLI that prints nothing), so the default only
# applies when the variable is unset
if [ "${1:-}" = "version" ]; then echo "${FAKE_VERSION-4.5.2}"; exit 0; fi
# SHOPIFY_QF_SAVE captures the --query-file the runner hands over — an extracted operation lives
# in a temp file the runner deletes right after the call
prev=""; for a in "$@"; do
  [ "$prev" = "--query-file" ] && [ -n "${SHOPIFY_QF_SAVE:-}" ] && cp "$a" "$SHOPIFY_QF_SAVE"
  prev="$a"
done
case "${FAKE_EXEC_MODE:-garbage}" in
  garbage) echo "unexpected CLI crash output" >&2; exit 1 ;;
  noauth)  echo "No stored app authentication found" >&2; exit 1 ;;
  ok)      echo '{"ok":true}'; exit 0 ;;
  # the CLI's shape for a server-side GraphQL error: a phrase, then the {"errors":…} JSON boxed in
  # box-drawing bars; `gqlfail-noisy` is the phrase with nothing parseable behind it
  gqlfail) printf 'GraphQL operation failed\n│ {"errors":[{"message":"Field x does not exist"}]} │\n' >&2; exit 1 ;;
  gqlfail-noisy) printf 'GraphQL operation failed\n│ see the logs │\n' >&2; exit 1 ;;
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

# G43: --operation on a multi-operation document — `store execute` has no operationName flag, so
# the runner hands it ONLY the named block plus every fragment; a query block carved out of a file
# that also holds a mutation must not be sent with --allow-mutations
L43="$TMP/sl43"; : > "$L43"; QF43="$TMP/qf43.graphql"; rm -f "$QF43"
rc=0; GQL_LOG="$L43" SHOPIFY_QF_SAVE="$QF43" FAKE_EXEC_MODE=ok \
  run_gql --query multi.graphql --operation FndA >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -q '"data":{"ok":true}' "$O" \
   && [ "$(grep -c 'store execute' "$L43")" -eq 1 ] && ! grep -q -- '--allow-mutations' "$L43" \
   && grep -q '^query FndA' "$QF43" && grep -q '^fragment F on Shop' "$QF43" && ! grep -q 'FndB' "$QF43"; then ok
else bad G43-operation-extracted "rc=$rc out=$(head -c 80 "$O") log=$(tr '\n' ';' < "$L43") qf=$(tr '\n' ';' < "$QF43" 2>&1)"; fi
# G43b: a name the document does not define — the store engine steps aside with the reason and
# the token engine gets the WHOLE document (the Admin API takes operationName; the runner does not
# pass one, so the caller sees the same document the file holds)
L43b="$TMP/sl43b"; : > "$L43b"
rc=0; M="$TMP/m43b"; GQL_LOG="$L43b" CURL_MARKER="$M" FAKE_EXEC_MODE=ok \
  run_gql --query multi.graphql --operation Nope >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -q '"ok":true' "$O" && [ -f "$M" ] && ! grep -q 'store execute' "$L43b" \
   && grep -q "could not extract operation 'Nope'" "$E"; then ok
else bad G43b-operation-missing-falls-back "rc=$rc out=$(head -c 80 "$O") err=$(head -c 200 "$E" | tr '\n' ' ') log=$(tr '\n' ';' < "$L43b")"; fi
# G43c: the mutation block from the same document does get --allow-mutations (the detection
# runs on the EXTRACTED file, not the source document)
L43c="$TMP/sl43c"; : > "$L43c"
rc=0; GQL_LOG="$L43c" FAKE_EXEC_MODE=ok run_gql --query multi.graphql --operation FndB >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -q '"data":{"ok":true}' "$O" && grep -q 'store execute.*--allow-mutations' "$L43c"; then ok
else bad G43c-operation-mutation-flag "rc=$rc out=$(head -c 80 "$O") log=$(tr '\n' ';' < "$L43c")"; fi

# G44: a definitive GraphQL error from `store execute` is an ANSWER, not an availability failure:
# the boxed {"errors":…} is unboxed onto stdout with exit 0 (the curl engine's HTTP-200 contract),
# the token engine is never tried — for a mutation that would risk executing it twice — and no
# store-skip verdict is recorded
QT44="$TMP/probe-gqlfail"; mkdir -p "$QT44"; L44="$TMP/sl44"; : > "$L44"
rc=0; M="$TMP/m44"; GQL_TMPDIR="$QT44" GQL_LOG="$L44" CURL_MARKER="$M" FAKE_EXEC_MODE=gqlfail \
  run_gql --query query.graphql >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ "$(jq -c '.errors[0].message' "$O" 2>/dev/null)" = '"Field x does not exist"' ] \
   && [ ! -f "$M" ] && [ "$(grep -c 'store execute' "$L44")" -eq 1 ] \
   && [ ! -f "$(gql_state "$QT44")/store-skip-test-store.myshopify.com" ]; then ok
else bad G44-gql-error-unboxed "rc=$rc out=$(head -c 120 "$O") err=$(head -c 160 "$E" | tr '\n' ' ') curl=$([ -f "$M" ] && echo yes || echo no)"; fi
rc=0; M="$TMP/m44m"; GQL_TMPDIR="$QT44" CURL_MARKER="$M" FAKE_EXEC_MODE=gqlfail \
  run_gql --query mutation.graphql >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -q '"errors"' "$O" && [ ! -f "$M" ] && ! grep -q 'store_execute_failed_mutation' "$E"; then ok
else bad G44b-gql-error-mutation-no-fallback "rc=$rc out=$(head -c 120 "$O") err=$(head -c 160 "$E" | tr '\n' ' ') curl=$([ -f "$M" ] && echo yes || echo no)"; fi
# G44c: the phrase without parseable JSON behind it is an unrecognized failure — a query falls back
# (naming the unparseable box), a mutation stops with the double-execution warning (G1 shape),
# and neither writes a sticky mark (G40 shape)
rc=0; M="$TMP/m44n"; GQL_TMPDIR="$QT44" CURL_MARKER="$M" FAKE_EXEC_MODE=gqlfail-noisy \
  run_gql --query query.graphql >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -q '"ok":true' "$O" && [ -f "$M" ] \
   && grep -q 'boxed error JSON could not be parsed' "$E"; then ok
else bad G44c-gql-error-noisy-query-falls-back "rc=$rc out=$(head -c 80 "$O") err=$(head -c 200 "$E" | tr '\n' ' ')"; fi
rc=0; M="$TMP/m44nm"; GQL_TMPDIR="$QT44" CURL_MARKER="$M" FAKE_EXEC_MODE=gqlfail-noisy \
  run_gql --query mutation.graphql >"$O" 2>"$E" || rc=$?
assert G44d-gql-error-noisy-mutation-stops 3 "$rc" "$E" "store_execute_failed_mutation"
if [ ! -f "$M" ] && [ ! -f "$(gql_state "$QT44")/store-skip-test-store.myshopify.com" ]; then ok
else bad G44d-no-fallback-no-mark "curl=$([ -f "$M" ] && echo yes || echo no) mark=$([ -f "$(gql_state "$QT44")/store-skip-test-store.myshopify.com" ] && echo yes || echo no)"; fi

# ---------------------------------------- create-preview-theme.sh cap classifier --
CAP_RE='theme limit|maximum number of themes|too many themes|may only have [0-9]+ themes'
if grep -qF "$CAP_RE" "$CPT"; then ok; else bad C1-pattern-in-script "cap regex in the test drifted from the script"; fi
if printf 'You have reached your theme limit.\n' | grep -qiE "$CAP_RE"; then ok; else bad C2-real-cap "true cap message not classified"; fi
if printf 'The maximum number of themes has been reached\n' | grep -qiE "$CAP_RE"; then ok; else bad C3-real-cap2 "true cap message not classified"; fi
# C3b: the wording the CLI actually prints — one boxed line, padded to the box width
if printf '│  A shop may only have 100 themes                                             │\n' \
   | grep -qiE "$CAP_RE"; then ok; else bad C3b-boxed-cap "boxed CLI cap message not classified"; fi
if printf 'Error pushing theme: rate limit exceeded, too many requests\n' | grep -qiE "$CAP_RE"; then
  bad C4-rate-limit-fp "rate-limit stderr still classified as theme cap"
else ok; fi

# -------------------------------------- create-preview-theme.sh against a stub CLI --
# The script is driven with a PATH shim for `shopify` that appends every argv line (and the
# Theme Access token it was handed) to $CPT_LOG, so "the push never ran" / "the orphan was
# deleted" are assertable, not inferred from the report.
# NB create-preview-theme.sh prints error= on STDOUT, not stderr — every case greps $O.
CPTD="$TMP/cpt"; mkdir -p "$CPTD/shim" "$CPTD/repo/assets" "$CPTD/repo/sections" "$CPTD/toml"
cp "$CPT" "$CPTD/cpt.sh"; cp "$COMMON" "$CPTD/"
printf 'x{}\n' > "$CPTD/repo/assets/app.css"
# a real section schema, so the overlay read-back's unknown-type filter has a KNOWN type
# (main-product, by filename; text, by schema block) to tell apart from an alien one
printf '<div></div>\n{%% schema %%}\n{"name":"Product","blocks":[{"type":"text","name":"Text"}]}\n{%% endschema %%}\n' > "$CPTD/repo/sections/main-product.liquid"
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
    # FAKE_LIST2 + FAKE_LIST_MARK: the FIRST list call answers FAKE_LIST (and drops the mark file);
    # every later call answers FAKE_LIST2 — how a test shows a theme "appearing" mid-run.
    if [ -n "${FAKE_LIST2:-}" ] && [ -f "${FAKE_LIST_MARK:-/dev/null}" ]; then printf '%s\n' "$FAKE_LIST2"
    elif [ -n "${FAKE_LIST:-}" ]; then
      [ -n "${FAKE_LIST_MARK:-}" ] && : > "$FAKE_LIST_MARK"
      printf '%s\n' "$FAKE_LIST"
    else cat <<'J'
[{"id":111,"name":"[DEV] Kever","role":"development"},{"id":555,"name":"[ELC-1] Kever","role":"unpublished"},{"id":999,"name":"Live Theme","role":"live"}]
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
    # FAKE_PULL_FAIL_NONDEV: only pulls off a NON-dev theme fail — the overlay read-back, while
    # the dev-theme settings pull stays healthy
    [ -n "${FAKE_PULL_FAIL_NONDEV:-}" ] && [ "$nid" != "111" ] && { echo "Error: could not pull (503)" >&2; exit 1; }
    p=""; prev=""; for a in "$@"; do [ "$prev" = "--path" ] && p="$a"; prev="$a"; done
    # FAKE_PULL_EMPTY: the pull exits 0 having written NOTHING — an id with no customizer content
    [ -n "${FAKE_PULL_EMPTY:-}" ] && { mkdir -p "$p"; exit 0; }
    mkdir -p "$p/config"; printf '{"current":{"pulled":1}}\n' > "$p/config/settings_data.json"
    # FAKE_PULL_TPL: the theme also carries a product template referencing a block type.
    # FAKE_PULL_BANNER prefixes it with the auto-generated /*…*/ header Shopify stamps onto every
    # theme *.json it serves — the real input shape, which plain jq refuses to parse.
    if [ -n "${FAKE_PULL_TPL:-}" ]; then
      mkdir -p "$p/templates"
      : > "$p/templates/product.json"
      [ -n "${FAKE_PULL_BANNER:-}" ] && printf '/*\n * Auto-generated by Shopify.\n */\n' >> "$p/templates/product.json"
      # settings.type is a CONTENT value, not a schema reference: only a structural read excludes
      # it, so its absence from unknown_types= is what tells the jq path apart from the raw scan
      printf '{"sections":{"main":{"type":"main-product","settings":{"type":"delivery_promo"},"blocks":{"b1":{"type":"delivery_banner"}},"block_order":["b1"]}},"order":["main"]}\n' >> "$p/templates/product.json"
    fi
    # FAKE_VERIFY_DROP: a pull off any NON-dev theme (the overlay read-back) omits these files —
    # Shopify's silent server-side rejection. FAKE_VERIFY_DROP_ONCE names a mark file: the drop
    # happens only while the mark is absent (consistency lag, not a rejection).
    if [ "$nid" != "111" ] && [ -n "${FAKE_VERIFY_DROP:-}" ]; then
      if [ -z "${FAKE_VERIFY_DROP_ONCE:-}" ] || [ ! -f "$FAKE_VERIFY_DROP_ONCE" ]; then
        [ -n "${FAKE_VERIFY_DROP_ONCE:-}" ] && : > "$FAKE_VERIFY_DROP_ONCE"
        for f in $FAKE_VERIFY_DROP; do rm -f "$p/$f"; done
      fi
    fi ;;
  "theme push")
    # FAKE_PUSH_THROTTLE_N throttles the first N CODE pushes (429-style stderr) then succeeds —
    # the retry loop's counterpart; FAKE_PUSH_COUNT is its cross-invocation counter file.
    if [ "$is_only" -eq 0 ] && [ -n "${FAKE_PUSH_THROTTLE_N:-}" ]; then
      n=0; [ -f "${FAKE_PUSH_COUNT:?}" ] && n="$(cat "$FAKE_PUSH_COUNT")"
      if [ "$n" -lt "$FAKE_PUSH_THROTTLE_N" ]; then
        echo $((n + 1)) > "$FAKE_PUSH_COUNT"
        printf '│  Throttled\n' >&2; exit 1
      fi
    fi
    [ "$is_only" -eq 1 ] && [ -n "${FAKE_PUSH_ONLY_FAIL:-}" ] && { printf '%s\n' "$FAKE_PUSH_ONLY_FAIL" >&2; exit 1; }
    [ "$is_only" -eq 0 ] && [ -n "${FAKE_PUSH_CODE_FAIL:-}" ] && { printf '%s\n' "$FAKE_PUSH_CODE_FAIL" >&2; exit 1; }
    # CPT_PUSH_PATH_SAVE keeps a copy of the assembled code dir a CODE push received — the script
    # deletes that temp dir on exit, so what it contained is only observable from inside the push
    if [ "$is_only" -eq 0 ] && [ -n "${CPT_PUSH_PATH_SAVE:-}" ]; then
      p=""; prev=""; for a in "$@"; do [ "$prev" = "--path" ] && p="$a"; prev="$a"; done
      [ -n "$p" ] && cp -R "$p" "$CPT_PUSH_PATH_SAVE"
    fi
    # FAKE_PUSH_JSON: the whole --json answer, verbatim — for a payload the default printf cannot
    # express (a gid-shaped theme id above all). Same gotcha: the value is never a ${…:-default}.
    [ "$is_only" -eq 0 ] && [ -n "${FAKE_PUSH_JSON:-}" ] && { printf '%s\n' "$FAKE_PUSH_JSON"; exit 0; }
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
# fake npm: `npm run <name>` resolves scripts.<name> out of ./package.json and runs it with sh,
# the way real npm does. Every invocation is appended to $CPT_LOG as `npm=…`, so "the default
# build ran" / "nothing was executed" are assertable rather than inferred.
cat > "$CPTD/shim/npm" <<'NPM'
#!/usr/bin/env bash
[ -n "${CPT_LOG:-}" ] && printf 'npm=%s\n' "$*" >> "$CPT_LOG"
[ "${1:-}" = "run" ] || { echo "npm shim: unhandled: $*" >&2; exit 1; }
cmd="$(node -e 'const fs=require("fs");const p=JSON.parse(fs.readFileSync("package.json","utf8"));const s=(p.scripts||{})[process.argv[1]];if(typeof s!=="string")process.exit(1);process.stdout.write(s)' "${2:-}")" \
  || { echo "npm ERR! Missing script: \"${2:-}\"" >&2; exit 1; }
sh -c "$cmd"
NPM
# The build targets the cases pass to --build-script; `build` is the one the script runs when no
# flag is passed at all.
cat > "$CPTD/repo/package.json" <<EOF
{
  "name": "cpt-fixture",
  "private": true,
  "scripts": {
    "build": "$CPTD/markbuild.sh",
    "markbuild": "$CPTD/markbuild.sh",
    "waitpull": "$CPTD/waitpull.sh",
    "overlap": "$CPTD/overlap.sh",
    "failbuild": "exit 1"
  }
}
EOF
chmod +x "$CPTD/shim/shopify" "$CPTD/shim/npm" "$CPTD/waitpull.sh" "$CPTD/overlap.sh" "$CPTD/markbuild.sh"

run_cpt() { # run_cpt <log-file> <env=val…> -- <args…>   ; stdout -> $O, stderr -> $E
  local log="$1"; shift
  local envs=(); while [ "$1" != "--" ]; do envs+=("$1"); shift; done; shift
  (cd "$CPTD/repo" && PATH="$CPTD/shim:$PATH" CPT_LOG="$log" env "${envs[@]}" \
     "$BASH_BIN" "$CPTD/cpt.sh" "$@") >"$O" 2>"$E"
}
cpt_calls() { grep -c "argv=$1" "$2" 2>/dev/null || true; }

# P0: the script sources _shopify-common.sh from its own dir — a copy without it stops with the
# stdout error= contract (exit 1) before the CLI is touched, so the fixture copy above is load-bearing
LONE_CPT="$TMP/lonecpt"; mkdir -p "$LONE_CPT"; cp "$CPT" "$LONE_CPT/cpt.sh"
rc=0; L="$TMP/cpt0"; : > "$L"
(cd "$CPTD/repo" && PATH="$CPTD/shim:$PATH" CPT_LOG="$L" "$BASH_BIN" "$LONE_CPT/cpt.sh" info) >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 1 ] && grep -q "^error=common_lib_not_found path=$LONE_CPT/_shopify-common.sh$" "$O" && [ ! -s "$L" ]; then ok
else bad P0-common-lib-missing "rc=$rc out=$(head -c 160 "$O" | tr '\n' ' ') log=$(tr '\n' ';' < "$L")"; fi

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
run_cpt "$L" CPT_PULL_MARK="$PM" -- create --name "PREVIEW-E" --build-script waitpull || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^theme_id=222$' "$O" && grep -q '^built=yes$' "$O" \
   && grep -q '^preview_url=https://' "$O" && [ -f "$PM" ]; then ok
else bad P7-pull-concurrent-with-build "rc=$rc out=$(tr '\n' ';' < "$O") err=$(head -c 160 "$E" | tr '\n' ' ')"; fi

# P7b (F3): a backgrounded pull that FAILS must never become a silent success, even when the
# build outlives it (the `wait` status is the only evidence left by then)
rc=0; L="$TMP/cpt7b"; : > "$L"; PM="$TMP/cpt7b.pull"; rm -f "$PM"
run_cpt "$L" CPT_PULL_MARK="$PM" FAKE_PULL_FAIL=1 -- create --name "PREVIEW-F" --build-script waitpull || rc=$?
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

# P9b (bug): the stderr the CLI really prints when the store is at the cap — a boxed sentence.
# Read as push_code_failed it sends the caller hunting a rejected asset that does not exist.
rc=0; L="$TMP/cpt9b"; : > "$L"
run_cpt "$L" FAKE_PUSH_CODE_FAIL='╭─ error ──────────────────────────────────────────────────────────────────────╮
│                                                                              │
│  A shop may only have 100 themes                                             │
╰──────────────────────────────────────────────────────────────────────────────╯' \
  -- create --name "PREVIEW-I2" --no-build || rc=$?
if [ "$rc" -ne 0 ] && grep -q 'error=theme_limit' "$O" && ! grep -q 'push_code_failed' "$O"; then ok
else bad P9b-theme-limit-boxed "rc=$rc out=$(tr '\n' ';' < "$O")"; fi

# P10 (pin): refresh onto a non-live theme pushes CODE only and never touches settings
rc=0; L="$TMP/cpt10"; : > "$L"
run_cpt "$L" NO=1 -- refresh --theme 555 --no-build || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^theme_id=555$' "$O" \
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

# P11 (bug): when `theme list` itself fails the role is unknown — an id no workspace records as
# session-theme is REFUSED (the live-theme guard cannot clear it), nothing pushed
rc=0; L="$TMP/cpt11"; : > "$L"
run_cpt "$L" FAKE_LIST_FAIL=1 -- refresh --theme 555 --no-build || rc=$?
if [ "$rc" -ne 0 ] && grep -q '^error=refresh_unverifiable theme=555 store=acme-dev' "$O" \
   && grep -q '^hint=.*--allow-unverified' "$O" && [ "$(cpt_calls 'theme push' "$L")" -eq 0 ]; then ok
else bad P11-list-outage-refresh-refused "rc=$rc out=$(head -c 200 "$O" | tr '\n' ' ') calls=$(tr '\n' ';' < "$L")"; fi

# P11b: --allow-unverified is the developer's override — the push proceeds without the store check
rc=0; L="$TMP/cpt11b"; : > "$L"
run_cpt "$L" FAKE_LIST_FAIL=1 -- refresh --theme 555 --no-build --allow-unverified || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^theme_id=555$' "$O" && ! grep -q 'error=' "$O" \
   && [ "$(cpt_calls 'theme push' "$L")" -eq 1 ]; then ok
else bad P11b-list-outage-allow-unverified "rc=$rc out=$(tr '\n' ';' < "$O")"; fi

# P11c/P11d: an id some workspace under .claude/tasks records as `session-theme:` is the routine
# refresh target and proceeds under the outage without any flag — matched as a whole id, so a
# recorded 555 does not clear 5550
mkdir -p "$CPTD/repo/.claude/tasks/ELC-1"
printf -- '- 2026-09-06 session-theme: 555 ([ELC-1] Kever) https://acme-dev.myshopify.com/?preview_theme_id=555\n' > "$CPTD/repo/.claude/tasks/ELC-1/notes.md"
rc=0; L="$TMP/cpt11c"; : > "$L"
run_cpt "$L" FAKE_LIST_FAIL=1 -- refresh --theme 555 --no-build || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^theme_id=555$' "$O" && [ "$(cpt_calls 'theme push' "$L")" -eq 1 ]; then ok
else bad P11c-list-outage-session-theme-proceeds "rc=$rc out=$(tr '\n' ';' < "$O")"; fi
rc=0; L="$TMP/cpt11d"; : > "$L"
run_cpt "$L" FAKE_LIST_FAIL=1 -- refresh --theme 5550 --no-build || rc=$?
if [ "$rc" -ne 0 ] && grep -q '^error=refresh_unverifiable theme=5550 ' "$O" \
   && [ "$(cpt_calls 'theme push' "$L")" -eq 0 ]; then ok
else bad P11d-list-outage-other-id-refused "rc=$rc out=$(head -c 200 "$O" | tr '\n' ' ')"; fi
# P11e/P11f (bug): valid JSON naming NO theme is an outage too — a store always lists its live
# theme — so it must not clear every id through the "absent id proceeds" branch; the recorded
# session theme still refreshes
rc=0; L="$TMP/cpt11e"; : > "$L"
run_cpt "$L" FAKE_LIST='{"themes":[]}' -- refresh --theme 5550 --no-build || rc=$?
if [ "$rc" -ne 0 ] && grep -q '^error=refresh_unverifiable theme=5550 ' "$O" \
   && [ "$(cpt_calls 'theme push' "$L")" -eq 0 ]; then ok
else bad P11e-empty-listing-refresh-refused "rc=$rc out=$(head -c 200 "$O" | tr '\n' ' ')"; fi
rc=0; L="$TMP/cpt11f"; : > "$L"
run_cpt "$L" FAKE_LIST='[]' -- refresh --theme 555 --no-build || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^theme_id=555$' "$O" && [ "$(cpt_calls 'theme push' "$L")" -eq 1 ]; then ok
else bad P11f-empty-listing-session-theme-proceeds "rc=$rc out=$(tr '\n' ';' < "$O")"; fi
rm -rf "$CPTD/repo/.claude"

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
run_cpt "$L" TMPDIR="$CPTT" FAKE_PULL_SLEEP=3 -- create --name "PREVIEW-J" --build-script failbuild || rc=$?
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
run_cpt "$L" TMPDIR="$CPTT2" FAKE_PULL_STUBBORN=1 FAKE_PULL_SLEEP=8 -- create --name "PREVIEW-K" --build-script failbuild || rc=$?
elapsed=$(( $(date +%s) - t0 ))
if [ "$rc" -ne 0 ] && grep -q 'error=build_failed' "$O" && [ "$elapsed" -le 3 ] \
   && [ "$(ls -A "$CPTT2" | wc -l | tr -d ' ')" -eq 0 ]; then ok
else bad P14b-stubborn-pull-bounded "rc=$rc elapsed=${elapsed}s left=$(ls -A "$CPTT2" | tr '\n' ' ')"; fi

# P15 (F3 pin): the pull must still be RUNNING when the build ends — that overlap IS the speedup, and
# nothing else in the suite can tell it apart from a pull that completed before the build started
rc=0; L="$TMP/cpt15"; : > "$L"; PM="$TMP/cpt15.start"; PD="$TMP/cpt15.done"; rm -f "$PM" "$PD"
run_cpt "$L" CPT_PULL_MARK="$PM" CPT_PULL_DONE="$PD" FAKE_PULL_SLEEP=2 \
  -- create --name "PREVIEW-L" --build-script overlap || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^theme_id=222$' "$O" && grep -q '^built=yes$' "$O" && [ -f "$PD" ]; then ok
else bad P15-pull-still-running-at-build-end "rc=$rc out=$(tr '\n' ';' < "$O") err=$(head -c 200 "$E" | tr '\n' ' ')"; fi

# P16 (bug): a `theme list` that comes back UNREADABLE (the CLI prints a deprecation/upgrade banner
# before the JSON — the shape json_field is written tolerantly for) must not disarm the live-theme
# guard. A positive match is impossible on a document jq cannot parse, so "no role" means UNKNOWN.
BANNER_LIST='Upgrade available: run `npm i -g @shopify/cli`
[{"id":999,"name":"Live Theme","role":"live"},{"id":111,"name":"[DEV] Kever","role":"development"},{"id":555,"name":"[ELC-1] Kever","role":"unpublished"}]'
rc=0; L="$TMP/cpt16"; : > "$L"
run_cpt "$L" FAKE_LIST="$BANNER_LIST" -- refresh --theme 999 --no-build || rc=$?
if [ "$rc" -ne 0 ] && grep -q 'error=live_theme_write_refused' "$O" \
   && [ "$(cpt_calls 'theme push' "$L")" -eq 0 ]; then ok
else bad P16-banner-live-refused "rc=$rc out=$(head -c 160 "$O" | tr '\n' ' ') calls=$(tr '\n' ';' < "$L")"; fi

# P16b: the banner does not break the ordinary lookups either
rc=0; L="$TMP/cpt16b"; : > "$L"
run_cpt "$L" FAKE_LIST="$BANNER_LIST" -- refresh --theme 555 --no-build || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^theme_id=555$' "$O"; then ok
else bad P16b-banner-nonlive-ok "rc=$rc out=$(tr '\n' ';' < "$O")"; fi

# P16d (bug): noise glued to the JSON's OWN line (an oclif spinner artifact `⠋ Fetching themes\r[…`,
# stray ANSI under FORCE_COLOR) — the salvage is byte-anchored, so this parses instead of turning
# into a cli_list_unreadable lockout on a perfectly healthy store
rc=0; L="$TMP/cpt16d"; : > "$L"
run_cpt "$L" FAKE_LIST='Fetching themes... [{"id":999,"name":"Live Theme","role":"live"},{"id":111,"name":"[DEV] Kever","role":"development"},{"id":555,"name":"[ELC-1] Kever","role":"unpublished"}]' \
  -- refresh --theme 555 --no-build || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^theme_id=555$' "$O"; then ok
else bad P16d-sameline-noise-salvaged "rc=$rc out=$(head -c 160 "$O" | tr '\n' ' ')"; fi

# P16c: a listing that came back and is not JSON at all is refused as unreadable — a different
# refusal from the EMPTY listing (P11: the call failed, refresh_unverifiable), and one no flag lifts
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

# P17c (bug): a listing that never ANSWERED on the --reuse path — "no match" out of nothing used to
# fall into the create path and stack a second same-named theme, which ambiguous_name then blocks
# for good. Refused; --allow-unverified (P17d) is the developer's way through.
rc=0; L="$TMP/cpt17c"; : > "$L"
run_cpt "$L" FAKE_LIST_FAIL=1 -- create --name "PREVIEW-X" --reuse --no-build || rc=$?
if [ "$rc" -ne 0 ] && grep -q '^error=reuse_unverifiable name="PREVIEW-X"' "$O" \
   && [ "$(cpt_calls 'theme push' "$L")" -eq 0 ]; then ok
else bad P17c-list-outage-reuse-refused "rc=$rc out=$(head -c 200 "$O" | tr '\n' ' ') calls=$(tr '\n' ';' < "$L")"; fi
rc=0; L="$TMP/cpt17d"; : > "$L"
run_cpt "$L" FAKE_LIST_FAIL=1 -- create --name "PREVIEW-X" --reuse --no-build --allow-unverified || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^theme_id=222$' "$O" && grep -q '^reused=false$' "$O"; then ok
else bad P17d-list-outage-reuse-allow-unverified "rc=$rc out=$(tr '\n' ';' < "$O")"; fi

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
run_cpt "$L" CPT_BUILD_MARK="$BM" -- create --name "Live Theme" --reuse --build-script markbuild || rc=$?
if [ "$rc" -ne 0 ] && grep -q 'error=live_theme_write_refused' "$O" && [ ! -f "$BM" ]; then ok
else bad P19-refusal-before-build "rc=$rc built=$([ -f "$BM" ] && echo yes || echo no) out=$(head -c 120 "$O" | tr '\n' ' ')"; fi
rc=0; L="$TMP/cpt19b"; : > "$L"; rm -f "$BM"
run_cpt "$L" CPT_BUILD_MARK="$BM" FAKE_LIST='[{"id":301,"name":"PREVIEW-DUP","role":"unpublished"},{"id":302,"name":"PREVIEW-DUP","role":"unpublished"}]' \
  -- create --name "PREVIEW-DUP" --reuse --build-script markbuild || rc=$?
if [ "$rc" -ne 0 ] && grep -q 'error=ambiguous_name' "$O" && [ ! -f "$BM" ]; then ok
else bad P19b-ambiguous-before-build "rc=$rc built=$([ -f "$BM" ] && echo yes || echo no)"; fi

# ------------------------------- create-preview-theme.sh --build-script: never a shell --
# The preview-theme and worktree skills pre-approve this script's whole argv, so the build target
# has to be a package.json script NAME run as argv: a value that reached a shell would be
# arbitrary execution with no permission prompt. Each case below proves the refusal lands before
# any store call AND that its payload never ran (the marker file is the only witness — an `error=`
# line alone would still be printed by a script that executed the payload first).

# P19c: the old `--build-cmd "<cmd>"` escape hatch is gone, and gone LOUDLY — silently ignoring it
# would leave every caller that still passes one building the wrong thing
rc=0; L="$TMP/cpt19c"; : > "$L"; INJ="$TMP/cpt19c.pwned"; rm -f "$INJ"
run_cpt "$L" NO=1 -- create --name "PREVIEW-BC" --build-cmd ": > $INJ" || rc=$?
if [ "$rc" -ne 0 ] && grep -q 'error=unknown arg: --build-cmd' "$O" && [ ! -f "$INJ" ] \
   && [ "$(cpt_calls 'theme' "$L")" -eq 0 ] && ! grep -q '^npm=' "$L"; then ok
else bad P19c-build-cmd-rejected "rc=$rc pwned=$([ -f "$INJ" ] && echo yes || echo no) out=$(head -c 160 "$O" | tr '\n' ' ')"; fi

# P19d: a name carrying shell metacharacters is refused before the store is touched
rc=0; L="$TMP/cpt19d"; : > "$L"; INJ="$TMP/cpt19d.pwned"; rm -f "$INJ"
run_cpt "$L" NO=1 -- create --name "PREVIEW-BS1" --build-script "build; : > $INJ" || rc=$?
if [ "$rc" -ne 0 ] && grep -q 'error=bad_build_script' "$O" && [ ! -f "$INJ" ] \
   && [ "$(cpt_calls 'theme' "$L")" -eq 0 ] && ! grep -q '^npm=' "$L"; then ok
else bad P19d-build-script-metachars "rc=$rc pwned=$([ -f "$INJ" ] && echo yes || echo no) out=$(head -c 160 "$O" | tr '\n' ' ')"; fi

# P19e: …and so is a command substitution, which an `eval` would run before it ever looked at it
rc=0; L="$TMP/cpt19e"; : > "$L"; INJ="$TMP/cpt19e.pwned"; rm -f "$INJ"
run_cpt "$L" NO=1 -- create --name "PREVIEW-BS2" --build-script "\$(: > $INJ)" || rc=$?
if [ "$rc" -ne 0 ] && grep -q 'error=bad_build_script' "$O" && [ ! -f "$INJ" ] \
   && [ "$(cpt_calls 'theme' "$L")" -eq 0 ] && ! grep -q '^npm=' "$L"; then ok
else bad P19e-build-script-substitution "rc=$rc pwned=$([ -f "$INJ" ] && echo yes || echo no) out=$(head -c 160 "$O" | tr '\n' ' ')"; fi

# P19ee: a dash-leading value is a flag for `npm run`, not a script name — refused as well
rc=0; L="$TMP/cpt19ee"; : > "$L"
run_cpt "$L" NO=1 -- create --name "PREVIEW-BS2b" --build-script -f || rc=$?
if [ "$rc" -ne 0 ] && grep -q 'error=bad_build_script' "$O" \
   && [ "$(cpt_calls 'theme' "$L")" -eq 0 ] && ! grep -q '^npm=' "$L"; then ok
else bad P19ee-build-script-leading-dash "rc=$rc out=$(head -c 160 "$O" | tr '\n' ' ')"; fi

# P19f: a well-formed name that package.json does not define is refused before the push, not left
# to `npm run` after the theme already exists
rc=0; L="$TMP/cpt19f"; : > "$L"
run_cpt "$L" NO=1 -- create --name "PREVIEW-BS3" --build-script nope || rc=$?
if [ "$rc" -ne 0 ] && grep -q 'error=build_script_missing (nope)' "$O" \
   && [ "$(cpt_calls 'theme push' "$L")" -eq 0 ] && [ "$(cpt_calls 'theme' "$L")" -eq 0 ]; then ok
else bad P19f-build-script-missing "rc=$rc out=$(head -c 160 "$O" | tr '\n' ' ') log=$(tr '\n' ';' < "$L")"; fi

# P19g: with no flag at all the build is `npm run build` — argv, and the package.json script
rc=0; L="$TMP/cpt19g"; : > "$L"; BM="$TMP/cpt19g.build"; rm -f "$BM"
run_cpt "$L" CPT_BUILD_MARK="$BM" -- create --name "PREVIEW-BD" || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^npm=run build$' "$L" && [ -f "$BM" ] && grep -q '^built=yes$' "$O"; then ok
else bad P19g-default-build-script "rc=$rc built=$([ -f "$BM" ] && echo yes || echo no) log=$(grep '^npm=' "$L" | tr '\n' ';') out=$(head -c 160 "$O" | tr '\n' ' ')"; fi

# P19h/P19i: refresh takes the same flag and owes the same two refusals — its own arg loop, so a
# fix applied to create alone leaves this path executing whatever it is handed
rc=0; L="$TMP/cpt19h"; : > "$L"; INJ="$TMP/cpt19h.pwned"; rm -f "$INJ"
run_cpt "$L" NO=1 -- refresh --theme 111 --build-script "build; : > $INJ" || rc=$?
if [ "$rc" -ne 0 ] && grep -q 'error=bad_build_script' "$O" && [ ! -f "$INJ" ] \
   && [ "$(cpt_calls 'theme' "$L")" -eq 0 ] && ! grep -q '^npm=' "$L"; then ok
else bad P19h-refresh-build-script-metachars "rc=$rc pwned=$([ -f "$INJ" ] && echo yes || echo no) out=$(head -c 160 "$O" | tr '\n' ' ')"; fi
rc=0; L="$TMP/cpt19i"; : > "$L"
run_cpt "$L" NO=1 -- refresh --theme 111 --build-script nope || rc=$?
if [ "$rc" -ne 0 ] && grep -q 'error=build_script_missing (nope)' "$O" \
   && [ "$(cpt_calls 'theme' "$L")" -eq 0 ]; then ok
else bad P19i-refresh-build-script-missing "rc=$rc out=$(head -c 160 "$O" | tr '\n' ' ') log=$(tr '\n' ';' < "$L")"; fi

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

# P20c: no token anywhere — the file scan matches nothing, and that no-match must surface as the
# script's own "no access token" line, never as a silent set -e abort inside the shared helper
rc=0; L="$TMP/cpt20c"; : > "$L"
run_cpt "$L" TOML_PATH="$CPTD/toml/notoken.toml" -- info || rc=$?
if [ "$rc" -eq 1 ] && grep -q '^error=no access token' "$O" && [ ! -s "$L" ]; then ok
else bad P20c-no-token "rc=$rc out=$(tr '\n' ';' < "$O") log=$(tr '\n' ';' < "$L")"; fi

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
run_cpt "$L" FAKE_LIST='[{"id":555,"name":"X"}]' -- refresh --theme 555 --no-build || rc=$?
if [ "$rc" -ne 0 ] && grep -q 'error=live_role_unreadable' "$O" \
   && [ "$(cpt_calls 'theme push' "$L")" -eq 0 ]; then ok
else bad P23-roleless-id-refused "rc=$rc out=$(head -c 160 "$O" | tr '\n' ' ') calls=$(tr '\n' ';' < "$L")"; fi

# P23b (pin): an id ABSENT from a readable listing still proceeds — absence is what a fresh or
# paginated-away theme looks like, and only found-but-roleless is the drift shape P23 refuses
rc=0; L="$TMP/cpt23b"; : > "$L"
run_cpt "$L" FAKE_LIST='[{"id":222,"name":"Other","role":"unpublished"}]' -- refresh --theme 333 --no-build || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^theme_id=333$' "$O"; then ok
else bad P23b-absent-id-proceeds "rc=$rc out=$(head -c 160 "$O" | tr '\n' ' ')"; fi

# ------------------------------ create-preview-theme.sh shared dev theme guard --
# P54 (bug): `refresh --theme <the toml's theme id>` overwrote the SHARED dev theme's code — the id
# the toml names as the settings source is never a push target unless a workspace records it as
# this stream's session theme. Refused before the build, nothing pushed.
rc=0; L="$TMP/cpt54"; : > "$L"
run_cpt "$L" NO=1 -- refresh --theme 111 || rc=$?
if [ "$rc" -ne 0 ] && grep -q '^error=dev_theme_write_refused theme=111 name=\[DEV\] Kever' "$O" \
   && grep -q '^hint=.*session-theme: 111' "$O" \
   && [ "$(cpt_calls 'theme push' "$L")" -eq 0 ] && ! grep -q '^npm=' "$L"; then ok
else bad P54-dev-theme-refresh-refused "rc=$rc out=$(head -c 200 "$O" | tr '\n' ' ') log=$(tr '\n' ';' < "$L")"; fi

# P54b (bug): the name path — `--reuse` resolving to the dev theme's own name pushed code onto it
# and then overlaid its settings onto itself
rc=0; L="$TMP/cpt54b"; : > "$L"
run_cpt "$L" NO=1 -- create --name "[DEV] Kever" --reuse --no-build || rc=$?
if [ "$rc" -ne 0 ] && grep -q '^error=dev_theme_write_refused theme=111 name=\[DEV\] Kever' "$O" \
   && [ "$(cpt_calls 'theme push' "$L")" -eq 0 ]; then ok
else bad P54b-dev-theme-reuse-refused "rc=$rc out=$(head -c 200 "$O" | tr '\n' ' ') calls=$(tr '\n' ';' < "$L")"; fi

# P54c: --allow-dev-theme is the one opt-out — a deliberate overwrite of the shared theme
rc=0; L="$TMP/cpt54c"; : > "$L"
run_cpt "$L" NO=1 -- refresh --theme 111 --no-build --allow-dev-theme || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^theme_id=111$' "$O" && [ "$(cpt_calls 'theme push' "$L")" -eq 1 ]; then ok
else bad P54c-dev-theme-allow-flag "rc=$rc out=$(tr '\n' ';' < "$O")"; fi

# P54c2 (blocker): --allow-unverified clears the listing-outage refusal ONLY — the dev-theme guard
# reads the toml, not the store, so an outage plus that flag must still refuse the shared theme
rc=0; L="$TMP/cpt54c2"; : > "$L"
run_cpt "$L" FAKE_LIST_FAIL=1 -- refresh --theme 111 --no-build --allow-unverified || rc=$?
if [ "$rc" -ne 0 ] && grep -q '^error=dev_theme_write_refused theme=111' "$O" \
   && [ "$(cpt_calls 'theme push' "$L")" -eq 0 ]; then ok
else bad P54c2-dev-theme-not-cleared-by-allow-unverified "rc=$rc out=$(head -c 200 "$O" | tr '\n' ' ')"; fi

# P54c3: `pin` takes neither flag — it pushes nothing, so there is nothing for them to override
rc=0; L="$TMP/cpt54c3"; : > "$L"
run_cpt "$L" NO=1 -- pin --theme 555 --allow-dev-theme || rc=$?
OUT54="$(cat "$O")"
rc2=0; run_cpt "$L" NO=1 -- pin --theme 555 --allow-unverified || rc2=$?
if [ "$rc" -ne 0 ] && printf '%s' "$OUT54" | grep -q 'error=unknown arg: --allow-dev-theme' \
   && [ "$rc2" -ne 0 ] && grep -q 'error=unknown arg: --allow-unverified' "$O" && [ ! -s "$L" ]; then ok
else bad P54c3-pin-rejects-flags "rc=$rc rc2=$rc2 out=$OUT54 out2=$(tr '\n' ';' < "$O")"; fi

# P54d/P54e (pin): after a pin the toml's `theme =` IS the session theme — the shared dev id moved
# onto the `# fnd:superseded` marker above it. The session id refreshes; the superseded one is
# still the shared theme and still refused.
FP54="$CPTD/toml/pinned.toml"
printf '[environments.development]\nstore = "acme-dev"\n# theme = "111"   # dev theme  # fnd:superseded\ntheme = "555"   # dev theme\npassword = "shptka_fixture1234"\n' > "$FP54"
rc=0; L="$TMP/cpt54d"; : > "$L"
run_cpt "$L" TOML_PATH="$FP54" -- refresh --theme 555 --no-build || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^theme_id=555$' "$O"; then ok
else bad P54d-pinned-toml-session-refresh-ok "rc=$rc out=$(tr '\n' ';' < "$O")"; fi
rc=0; L="$TMP/cpt54e"; : > "$L"
run_cpt "$L" TOML_PATH="$FP54" -- refresh --theme 111 --no-build || rc=$?
if [ "$rc" -ne 0 ] && grep -q '^error=dev_theme_write_refused theme=111' "$O" \
   && [ "$(cpt_calls 'theme push' "$L")" -eq 0 ]; then ok
else bad P54e-pinned-toml-superseded-refused "rc=$rc out=$(head -c 200 "$O" | tr '\n' ' ')"; fi

# P54f/P54f2 (bug): a HAND-written session id (pin reported pin=unchanged — no marker, no tag) is
# indistinguishable from the shared theme in the toml; only the workspace's `session-theme:` line
# tells them apart. Recorded → proceeds; unrecorded → refused with the record-first hint.
FH54="$CPTD/toml/hand.toml"
printf '[environments.development]\nstore = "acme-dev"\ntheme = "555"\npassword = "shptka_fixture1234"\n' > "$FH54"
mkdir -p "$CPTD/repo/.claude/tasks/ELC-1"
printf -- '- 2026-09-06 worktree `x` on branch `y`, dev-port: 9293\n- 2026-09-06 session-theme: 555 ([ELC-1] Kever) https://acme-dev.myshopify.com/?preview_theme_id=555\n' > "$CPTD/repo/.claude/tasks/ELC-1/notes.md"
rc=0; L="$TMP/cpt54f"; : > "$L"
run_cpt "$L" TOML_PATH="$FH54" -- refresh --theme 555 --no-build || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^theme_id=555$' "$O"; then ok
else bad P54f-hand-pinned-recorded-ok "rc=$rc out=$(tr '\n' ';' < "$O")"; fi
rm -rf "$CPTD/repo/.claude"
rc=0; L="$TMP/cpt54f2"; : > "$L"
run_cpt "$L" TOML_PATH="$FH54" -- refresh --theme 555 --no-build || rc=$?
if [ "$rc" -ne 0 ] && grep -q '^error=dev_theme_write_refused theme=555' "$O" \
   && grep -q '^hint=.*session-theme: 555' "$O" && [ "$(cpt_calls 'theme push' "$L")" -eq 0 ]; then ok
else bad P54f2-hand-pinned-unrecorded-refused "rc=$rc out=$(head -c 200 "$O" | tr '\n' ' ')"; fi

# P54g (pin): a session-owned appended line (`# fnd:session-theme` tag) means the block never had a
# `theme =` of its own — there is no shared dev id in this file to protect
FG54="$CPTD/toml/tagged.toml"
printf '[environments.development]\nstore = "acme-dev"\ntheme = "555" # fnd:session-theme\npassword = "shptka_fixture1234"\n' > "$FG54"
rc=0; L="$TMP/cpt54g"; : > "$L"
run_cpt "$L" TOML_PATH="$FG54" -- refresh --theme 555 --no-build || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^theme_id=555$' "$O"; then ok
else bad P54g-tagged-line-no-dev-theme "rc=$rc out=$(tr '\n' ';' < "$O")"; fi

# P54h: the tag is matched by line shape — a comment merely mentioning it does not disarm the guard
FT54="$CPTD/toml/tagcomment.toml"
printf '[environments.development]\n# see fnd:session-theme in the docs\nstore = "acme-dev"\ntheme = "111"\npassword = "shptka_fixture1234"\n' > "$FT54"
rc=0; L="$TMP/cpt54h"; : > "$L"
run_cpt "$L" TOML_PATH="$FT54" -- refresh --theme 111 --no-build || rc=$?
if [ "$rc" -ne 0 ] && grep -q '^error=dev_theme_write_refused theme=111' "$O" \
   && [ "$(cpt_calls 'theme push' "$L")" -eq 0 ]; then ok
else bad P54h-tag-in-comment-does-not-disarm "rc=$rc out=$(head -c 200 "$O" | tr '\n' ' ')"; fi

# P54i (bug): a multi-block toml pinned in a block OTHER than the one supplying the settings source
# — the first-marker reader guarded 333 only and left the shared dev theme 111 open. Real pin run,
# so the marker shape is the one pin_toml writes; every superseded id AND the settings source refuse.
FI54="$CPTD/toml/twoblock.toml"
printf '[environments.dev]\nstore = "acme-dev"\ntheme = "111"\npassword = "shptka_fixture1234"\n\n[environments.staging]\nstore = "acme-dev"\ntheme = "333"\n' > "$FI54"
rc=0; L="$TMP/cpt54i"; : > "$L"
run_cpt "$L" TOML_PATH="$FI54" -- pin --theme 555 --env staging || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^superseded_theme_id=333$' "$O" && grep -q 'fnd:superseded' "$FI54"; then ok
else bad P54i-two-block-pin-setup "rc=$rc out=$(tr '\n' ';' < "$O")"; fi
for id in 111 333; do
  rc=0; L="$TMP/cpt54i$id"; : > "$L"
  run_cpt "$L" TOML_PATH="$FI54" -- refresh --theme "$id" --no-build || rc=$?
  if [ "$rc" -ne 0 ] && grep -q "^error=dev_theme_write_refused theme=$id" "$O" \
     && [ "$(cpt_calls 'theme push' "$L")" -eq 0 ]; then ok
  else bad "P54i-two-block-refused-$id" "rc=$rc out=$(head -c 200 "$O" | tr '\n' ' ')"; fi
done
rc=0; L="$TMP/cpt54i555"; : > "$L"
run_cpt "$L" TOML_PATH="$FI54" -- refresh --theme 555 --no-build || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^theme_id=555$' "$O"; then ok
else bad P54i-two-block-session-ok "rc=$rc out=$(tr '\n' ';' < "$O")"; fi

# P54j (bug): the tagged branch — a theme-less dev block gets `theme = "555" # fnd:session-theme`
# appended while the settings source (777) comes from another block; the tag disarmed the guard
FJ54="$CPTD/toml/prodfirst.toml"
printf '[environments.production]\nstore = "acme-dev"\ntheme = "777"\n\n[environments.dev]\nstore = "acme-dev"\npassword = "shptka_fixture1234"\n' > "$FJ54"
rc=0; L="$TMP/cpt54j"; : > "$L"
run_cpt "$L" TOML_PATH="$FJ54" -- pin --theme 555 || rc=$?
if [ "$rc" -eq 0 ] && grep -q 'theme = "555" # fnd:session-theme' "$FJ54"; then ok
else bad P54j-tagged-pin-setup "rc=$rc out=$(tr '\n' ';' < "$O")"; fi
rc=0; L="$TMP/cpt54j777"; : > "$L"
run_cpt "$L" TOML_PATH="$FJ54" -- refresh --theme 777 --no-build || rc=$?
if [ "$rc" -ne 0 ] && grep -q '^error=dev_theme_write_refused theme=777' "$O" \
   && [ "$(cpt_calls 'theme push' "$L")" -eq 0 ]; then ok
else bad P54j-tagged-other-block-refused "rc=$rc out=$(head -c 200 "$O" | tr '\n' ' ')"; fi
rc=0; L="$TMP/cpt54j555"; : > "$L"
run_cpt "$L" TOML_PATH="$FJ54" -- refresh --theme 555 --no-build || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^theme_id=555$' "$O"; then ok
else bad P54j-tagged-session-ok "rc=$rc out=$(tr '\n' ';' < "$O")"; fi

# P54k: a COMMENTED tagged line (a pin dupe commented out) is not the settings source's tag —
# same uncommented-only test as pin_toml's own `tagged`
FK54="$CPTD/toml/tagcommented.toml"
printf '[environments.development]\nstore = "acme-dev"\n# theme = "555" # fnd:session-theme\ntheme = "111"\npassword = "shptka_fixture1234"\n' > "$FK54"
rc=0; L="$TMP/cpt54k"; : > "$L"
run_cpt "$L" TOML_PATH="$FK54" -- refresh --theme 111 --no-build || rc=$?
if [ "$rc" -ne 0 ] && grep -q '^error=dev_theme_write_refused theme=111' "$O" \
   && [ "$(cpt_calls 'theme push' "$L")" -eq 0 ]; then ok
else bad P54k-commented-tag-does-not-disarm "rc=$rc out=$(head -c 200 "$O" | tr '\n' ' ')"; fi

# P54l: a marker whose value is a NAME still marks the block as pinned — the line below it is the
# session theme, not a fallback to "the settings source is the dev theme"
FL54="$CPTD/toml/namemarker.toml"
printf '[environments.development]\nstore = "acme-dev"\n# theme = "Kever Dev"  # fnd:superseded\ntheme = "555"\npassword = "shptka_fixture1234"\n' > "$FL54"
rc=0; L="$TMP/cpt54l"; : > "$L"
run_cpt "$L" TOML_PATH="$FL54" -- refresh --theme 555 --no-build || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^theme_id=555$' "$O"; then ok
else bad P54l-name-marker-session-ok "rc=$rc out=$(tr '\n' ';' < "$O")"; fi

# P58: a leading zero would clear every string-compared guard (listing, dev theme, notes) and still
# reach `theme push --theme 0111` — refused before the CLI is called, on refresh and pin alike
rc=0; L="$TMP/cpt58"; : > "$L"
run_cpt "$L" NO=1 -- refresh --theme 0111 --no-build || rc=$?
OUT58="$(cat "$O")"
rc2=0; run_cpt "$L" NO=1 -- pin --theme 0111 || rc2=$?
if [ "$rc" -ne 0 ] && [ "$rc2" -ne 0 ] && printf '%s' "$OUT58" | grep -q "^error=invalid_theme_id theme='0111'" \
   && grep -q "^error=invalid_theme_id theme='0111'" "$O" && [ ! -s "$L" ]; then ok
else bad P58-leading-zero-id-refused "rc=$rc rc2=$rc2 out=$(head -c 200 "$O" | tr '\n' ' ') log=$(tr '\n' ';' < "$L")"; fi

# ------------------------------ create-preview-theme.sh throttle retry + orphan reap --
# Shopify rate-limits per store+token (a running `shopify theme dev` draws on the SAME budget), so
# a bulk push can land `Throttled` while every other call is healthy — seen live on a real store
# 2026-07-26, twice, at 0% upload. FND_CPT_THROTTLE_WAITS="0 0" makes the retry pauses instant.

# P24 (bug): a code push that throttles twice then clears must succeed via the retry loop —
# without it the run dies on the FIRST 429 and (on create) orphans the server-side theme
rc=0; L="$TMP/cpt24"; : > "$L"; CNT="$TMP/cpt24.count"; rm -f "$CNT"
run_cpt "$L" FND_CPT_THROTTLE_WAITS="0 0" FAKE_PUSH_THROTTLE_N=2 FAKE_PUSH_COUNT="$CNT" \
  -- create --name "PREVIEW-T" --no-build || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^theme_id=222$' "$O" \
   && [ "$(grep -c 'argv=theme push.*--unpublished' "$L")" -eq 3 ]; then ok
else bad P24-throttle-retry-succeeds "rc=$rc out=$(head -c 160 "$O" | tr '\n' ' ') pushes=$(grep -c 'argv=theme push' "$L")"; fi

# P25 (bug): a throttle that HOLDS through the retries, after the CLI already created the theme
# server-side (`--unpublished` creates first, uploads second) — the run must name the throttle as
# the cause, find the theme it created (fresh list vs the pre-push snapshot) and delete it, or a
# slot burns toward the 20/100 cap with no `created_theme=` line
rc=0; L="$TMP/cpt25"; : > "$L"; MK="$TMP/cpt25.mark"; rm -f "$MK"
run_cpt "$L" FND_CPT_THROTTLE_WAITS="0" FAKE_PUSH_CODE_FAIL='│  Throttled' FAKE_LIST_MARK="$MK" \
  FAKE_LIST='[{"id":999,"name":"Live Theme","role":"live"}]' \
  FAKE_LIST2='[{"id":999,"name":"Live Theme","role":"live"},{"id":777,"name":"PREVIEW-T","role":"unpublished"}]' \
  -- create --name "PREVIEW-T" --no-build || rc=$?
if [ "$rc" -ne 0 ] && grep -q 'error=push_code_failed' "$O" && grep -q 'cause=throttled' "$O" \
   && grep -q '^created_theme=777$' "$O" && grep -q '^created_theme_deleted=yes$' "$O" \
   && grep -q 'argv=theme delete.*777' "$L"; then ok
else bad P25-throttled-orphan-reaped "rc=$rc out=$(head -c 200 "$O" | tr '\n' ' ') calls=$(tr '\n' ';' < "$L")"; fi

# P25b (pin): only the id that APPEARED across the push is this run's — a pre-existing theme wearing
# the same name is never deleted (Shopify allows duplicate names)
rc=0; L="$TMP/cpt25b"; : > "$L"; MK="$TMP/cpt25b.mark"; rm -f "$MK"
run_cpt "$L" FND_CPT_THROTTLE_WAITS="0" FAKE_PUSH_CODE_FAIL='│  Throttled' FAKE_LIST_MARK="$MK" \
  FAKE_LIST='[{"id":600,"name":"PREVIEW-T","role":"unpublished"}]' \
  FAKE_LIST2='[{"id":600,"name":"PREVIEW-T","role":"unpublished"},{"id":777,"name":"PREVIEW-T","role":"unpublished"}]' \
  -- create --name "PREVIEW-T" --no-build || rc=$?
if [ "$rc" -ne 0 ] && grep -q '^created_theme=777$' "$O" \
   && grep -q 'argv=theme delete.*777' "$L" && ! grep -q 'argv=theme delete.*600' "$L"; then ok
else bad P25b-preexisting-name-kept "rc=$rc out=$(head -c 200 "$O" | tr '\n' ' ') calls=$(tr '\n' ';' < "$L")"; fi

# P26 (pin): a throttle that fired BEFORE the server-side create (no new id in the fresh list) must
# not invent a `created_theme=` claim or delete anything
rc=0; L="$TMP/cpt26"; : > "$L"
run_cpt "$L" FND_CPT_THROTTLE_WAITS="0" FAKE_PUSH_CODE_FAIL='│  Throttled' \
  -- create --name "PREVIEW-T" --no-build || rc=$?
if [ "$rc" -ne 0 ] && grep -q 'error=push_code_failed' "$O" && grep -q 'cause=throttled' "$O" \
   && ! grep -q 'created_theme=' "$O" && [ "$(cpt_calls 'theme delete' "$L")" -eq 0 ]; then ok
else bad P26-no-create-no-reap "rc=$rc out=$(head -c 200 "$O" | tr '\n' ' ') calls=$(tr '\n' ';' < "$L")"; fi

# P27 (bug): the overlay push throttling through its retries reports cause=throttled (the actionable
# hint), not the box-drawing frame line the generic `error|fail` grep fishes out of the CLI's output
rc=0; L="$TMP/cpt27"; : > "$L"
run_cpt "$L" FND_CPT_THROTTLE_WAITS="0" FAKE_PUSH_ONLY_FAIL='│  Throttled' \
  -- create --name "PREVIEW-T" --no-build || rc=$?
if [ "$rc" -ne 0 ] && grep -q 'error=overlay_push_failed' "$O" && grep -q 'cause=throttled' "$O" \
   && grep -q '^created_theme_deleted=yes$' "$O"; then ok
else bad P27-overlay-throttle-cause "rc=$rc out=$(head -c 200 "$O" | tr '\n' ' ')"; fi

# P28 (pin): refresh shares the retry loop — one throttled 429, then success on the second attempt
rc=0; L="$TMP/cpt28"; : > "$L"; CNT="$TMP/cpt28.count"; rm -f "$CNT"
run_cpt "$L" FND_CPT_THROTTLE_WAITS="0 0" FAKE_PUSH_THROTTLE_N=1 FAKE_PUSH_COUNT="$CNT" \
  -- refresh --theme 555 --no-build || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^theme_id=555$' "$O" \
   && [ "$(cpt_calls 'theme push' "$L")" -eq 2 ]; then ok
else bad P28-refresh-throttle-retry "rc=$rc out=$(head -c 160 "$O" | tr '\n' ' ')"; fi

# ------------------------------ create-preview-theme.sh overlay read-back (silent drop) --
# Shopify can reject an overlaid *.json server-side while `theme push` exits 0 with a CLEAN
# stderr — observed live on a real store 2026-08-31: a dev-theme templates/product.json carrying
# a block type absent from the branch's schemas never landed and every PDP on the "successful"
# preview 404'd. The stderr-worded drift greps (P18) cannot see this class; only a read-back can.

# P53 (bug): the drop is DETECTED — create still exits 0 (everything else landed; recovery is
# per-file via theme-json.sh set, and deleting the theme would replay the same drop), but
# overlay=partial + a warn= line naming the file and the alien type replace the silent success
rc=0; L="$TMP/cpt53"; : > "$L"
run_cpt "$L" FND_CPT_OVERLAY_VERIFY_WAIT=0 FAKE_PULL_TPL=1 FAKE_VERIFY_DROP="templates/product.json" \
  -- create --name "PREVIEW-V" --no-build || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^overlay=partial$' "$O" \
   && grep -q '^warn=overlay_file_dropped file=templates/product.json unknown_types=delivery_banner$' "$O" \
   && grep -q '^theme_id=222$' "$O" && grep -q '^hint=' "$O" \
   && [ "$(cpt_calls 'theme delete' "$L")" -eq 0 ]; then ok
else bad P53-silent-drop-detected "rc=$rc out=$(tr '\n' ';' < "$O")"; fi

# P53b (pin): a clean overlay verifies — the read-back pull runs against the NEW theme and the
# happy path gains overlay=verified with no warn
rc=0; L="$TMP/cpt53b"; : > "$L"
run_cpt "$L" FAKE_PULL_TPL=1 -- create --name "PREVIEW-V" --no-build || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^overlay=verified$' "$O" && ! grep -q 'warn=overlay' "$O" \
   && grep -q 'argv=theme pull --store acme-dev --theme 222 ' "$L"; then ok
else bad P53b-clean-overlay-verified "rc=$rc out=$(tr '\n' ';' < "$O") log=$(tr '\n' ';' < "$L")"; fi

# P53c (pin): a file that shows up on the RE-pull was consistency lag, not a rejection — no warn
rc=0; L="$TMP/cpt53c"; : > "$L"; MK="$TMP/cpt53c.mark"; rm -f "$MK"
run_cpt "$L" FND_CPT_OVERLAY_VERIFY_WAIT=0 FAKE_PULL_TPL=1 FAKE_VERIFY_DROP="templates/product.json" \
  FAKE_VERIFY_DROP_ONCE="$MK" -- create --name "PREVIEW-V" --no-build || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^overlay=verified$' "$O" && ! grep -q 'warn=overlay' "$O"; then ok
else bad P53c-lag-not-a-drop "rc=$rc out=$(tr '\n' ';' < "$O")"; fi

# P53d (pin): the read-back pull FAILING is unverified — never a drop claim, and never a failed
# run: a verify outage must not fail a run whose pushes all succeeded
rc=0; L="$TMP/cpt53d"; : > "$L"
run_cpt "$L" FAKE_PULL_TPL=1 FAKE_PULL_FAIL_NONDEV=1 -- create --name "PREVIEW-V" --no-build || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^overlay=unverified$' "$O" && grep -q '^warn=overlay_unverified' "$O" \
   && ! grep -q 'overlay_file_dropped' "$O" && grep -q '^theme_id=222$' "$O"; then ok
else bad P53d-verify-outage-nonfatal "rc=$rc out=$(tr '\n' ';' < "$O")"; fi

# P53e (pin): FND_CPT_OVERLAY_VERIFY=0 skips — no read-back pull at all, overlay=skipped
rc=0; L="$TMP/cpt53e"; : > "$L"
run_cpt "$L" FND_CPT_OVERLAY_VERIFY=0 FAKE_PULL_TPL=1 FAKE_VERIFY_DROP="templates/product.json" \
  -- create --name "PREVIEW-V" --no-build || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^overlay=skipped$' "$O" && ! grep -q 'warn=overlay' "$O" \
   && [ "$(cpt_calls 'theme pull' "$L")" -eq 1 ]; then ok
else bad P53e-verify-kill-switch "rc=$rc out=$(tr '\n' ';' < "$O") pulls=$(cpt_calls 'theme pull' "$L")"; fi

# P53f (bug): the REAL input shape — Shopify stamps a /*…*/ banner onto every *.json it serves, so
# a jq that is handed the file as-is always fails and the type read silently degrades to the raw
# grep. Banner stripped, the same drop still names exactly the one alien type.
rc=0; L="$TMP/cpt53f"; : > "$L"
run_cpt "$L" FND_CPT_OVERLAY_VERIFY_WAIT=0 FAKE_PULL_BANNER=1 FAKE_PULL_TPL=1 \
  FAKE_VERIFY_DROP="templates/product.json" -- create --name "PREVIEW-V" --no-build || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^overlay=partial$' "$O" \
   && grep -q '^warn=overlay_file_dropped file=templates/product.json unknown_types=delivery_banner$' "$O"; then ok
else bad P53f-banner-still-typed "rc=$rc out=$(tr '\n' ';' < "$O")"; fi

# P53g (bug): a malformed wait falls back to the default instead of handing `sleep` an argument it
# refuses — under `set -e` that aborted the run AFTER the theme existed, so stdout carried neither
# the id nor an error=. `1.2.3` passes a bytes-only filter, which is why it is the fixture here;
# this is the one row in the section that pays the fallback pause.
rc=0; L="$TMP/cpt53g"; : > "$L"
run_cpt "$L" FND_CPT_OVERLAY_VERIFY_WAIT=1.2.3 FAKE_PULL_TPL=1 \
  FAKE_VERIFY_DROP="templates/product.json" -- create --name "PREVIEW-V" --no-build || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^theme_id=222$' "$O" && grep -q '^overlay=partial$' "$O"; then ok
else bad P53g-malformed-wait "rc=$rc out=$(tr '\n' ';' < "$O") err=$(head -c 200 "$E" | tr '\n' ' ')"; fi

# P53h (pin): a dropped file with no section/block types to name gets the BARE warn line —
# unknown_types= is omitted, never printed empty, so a reader is not told to hunt a phantom type
rc=0; L="$TMP/cpt53h"; : > "$L"
run_cpt "$L" FND_CPT_OVERLAY_VERIFY_WAIT=0 FAKE_VERIFY_DROP="config/settings_data.json" \
  -- create --name "PREVIEW-V" --no-build || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^overlay=partial$' "$O" \
   && grep -q '^warn=overlay_file_dropped file=config/settings_data.json$' "$O"; then ok
else bad P53h-bare-warn "rc=$rc out=$(tr '\n' ';' < "$O")"; fi

# P53i (bug): the read-back runs on the --reuse path too — the drop is likeliest there, and a
# reused theme must still not be deleted over a warning
rc=0; L="$TMP/cpt53i"; : > "$L"
run_cpt "$L" FAKE_LIST='[{"id":555,"name":"PREVIEW-V","role":"unpublished"}]' \
  FND_CPT_OVERLAY_VERIFY_WAIT=0 FAKE_PULL_TPL=1 FAKE_VERIFY_DROP="templates/product.json" \
  -- create --name "PREVIEW-V" --reuse --no-build || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^theme_id=555$' "$O" && grep -q '^reused=true$' "$O" \
   && grep -q '^overlay=partial$' "$O" \
   && grep -q '^warn=overlay_file_dropped file=templates/product.json unknown_types=delivery_banner$' "$O" \
   && [ "$(cpt_calls 'theme delete' "$L")" -eq 0 ]; then ok
else bad P53i-reuse-verified "rc=$rc out=$(tr '\n' ';' < "$O")"; fi

# P55 (bug): a dev-theme pull that exits 0 with NO settings file used to push nothing and read
# back as "nothing missing" — overlay=verified on a preview carrying default settings. On a fresh
# create that is a failed overlay: the code-only theme is deleted and named, like any pull failure
rc=0; L="$TMP/cpt55"; : > "$L"
run_cpt "$L" FAKE_PULL_EMPTY=1 -- create --name "PREVIEW-E" --no-build || rc=$?
if [ "$rc" -ne 0 ] && grep -q '^error=overlay_pull_failed$' "$O" \
   && grep -q '^cause=.*0 \*\.json' "$O" && grep -q '^created_theme=222$' "$O" \
   && grep -q '^created_theme_deleted=yes$' "$O" && ! grep -q '^overlay=' "$O" \
   && [ "$(grep -c 'argv=theme push.*--only' "$L")" -eq 0 ] \
   && [ "$(grep -c 'argv=theme delete --store acme-dev --theme 222 --force' "$L")" -eq 1 ]; then ok
else bad P55-overlay-empty-create "rc=$rc out=$(tr '\n' ';' < "$O") log=$(tr '\n' ';' < "$L")"; fi

# P55b (bug): on --reuse deletion is off the table — the theme keeps its previous settings, and
# the run says so as overlay=empty + warn=overlay_empty instead of a vacuous verified
rc=0; L="$TMP/cpt55b"; : > "$L"
run_cpt "$L" FAKE_PULL_EMPTY=1 -- create --name "[ELC-1] Kever" --reuse --no-build || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^theme_id=555$' "$O" && grep -q '^reused=true$' "$O" \
   && grep -q '^overlay=empty$' "$O" && grep -q '^warn=overlay_empty dev_theme_id=111 ' "$O" \
   && ! grep -q 'overlay_file_dropped\|overlay_unverified' "$O" \
   && [ "$(grep -c 'argv=theme push.*--only' "$L")" -eq 0 ] \
   && [ "$(cpt_calls 'theme delete' "$L")" -eq 0 ]; then ok
else bad P55b-overlay-empty-reuse "rc=$rc out=$(tr '\n' ';' < "$O") log=$(tr '\n' ';' < "$L")"; fi

# P56: the repo's .shopifyignore rides along into the pushed code dir MINUS its locale lines — a
# `locales/*.json` exclude (plus its `!` negations) would leave a fresh preview with no locale
# files at all; every other exclude stays. The fixture file is removed afterwards: every later
# cpt case shares this repo.
printf 'locales/*.json\n!locales/en.default.json\nconfig/settings_data.json\n' > "$CPTD/repo/.shopifyignore"
rc=0; L="$TMP/cpt56"; : > "$L"; SAVE56="$TMP/cpt56.push"; rm -rf "$SAVE56"
run_cpt "$L" CPT_PUSH_PATH_SAVE="$SAVE56" -- refresh --theme 555 --no-build || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^theme_id=555$' "$O" && [ -f "$SAVE56/assets/app.css" ] \
   && [ "$(cat "$SAVE56/.shopifyignore")" = 'config/settings_data.json' ] \
   && [ "$(cat "$CPTD/repo/.shopifyignore")" = "$(printf 'locales/*.json\n!locales/en.default.json\nconfig/settings_data.json')" ]; then ok
else bad P56-shopifyignore-locales-stripped "rc=$rc out=$(head -c 160 "$O" | tr '\n' ' ') pushed=$(cat "$SAVE56/.shopifyignore" 2>&1 | tr '\n' ';')"; fi
rm -f "$CPTD/repo/.shopifyignore"
# P56b: no .shopifyignore in the repo → none is invented in the pushed dir
rc=0; L="$TMP/cpt56b"; : > "$L"; SAVE56B="$TMP/cpt56b.push"; rm -rf "$SAVE56B"
run_cpt "$L" CPT_PUSH_PATH_SAVE="$SAVE56B" -- refresh --theme 555 --no-build || rc=$?
if [ "$rc" -eq 0 ] && [ -f "$SAVE56B/assets/app.css" ] && [ ! -e "$SAVE56B/.shopifyignore" ]; then ok
else bad P56b-no-shopifyignore "rc=$rc out=$(head -c 160 "$O" | tr '\n' ' ') ls=$(ls -a "$SAVE56B" 2>&1 | tr '\n' ' ')"; fi

# P57: the cleanup delete itself failing is reported as created_theme_deleted=failed — the reader
# acts on that value (the theme is still burning a slot), so it must never read `yes` or vanish.
# Both producers: the overlay failure path on a fresh create (P4 shape) …
rc=0; L="$TMP/cpt57"; : > "$L"
run_cpt "$L" FAKE_PULL_FAIL=1 FAKE_DELETE_FAIL=1 -- create --name "PREVIEW-Z" --no-build || rc=$?
if [ "$rc" -ne 0 ] && grep -q 'error=overlay_pull_failed' "$O" \
   && grep -q '^created_theme=222$' "$O" && grep -q '^created_theme_deleted=failed$' "$O" \
   && [ "$(cpt_calls 'theme delete --store acme-dev --theme 222 --force' "$L")" -eq 1 ]; then ok
else bad P57-delete-failed-overlay "rc=$rc out=$(tr '\n' ';' < "$O") log=$(tr '\n' ';' < "$L")"; fi
# … and the throttled-create orphan reap (P25 shape)
rc=0; L="$TMP/cpt57b"; : > "$L"; MK="$TMP/cpt57b.mark"; rm -f "$MK"
run_cpt "$L" FND_CPT_THROTTLE_WAITS="0" FAKE_PUSH_CODE_FAIL='│  Throttled' FAKE_LIST_MARK="$MK" FAKE_DELETE_FAIL=1 \
  FAKE_LIST='[{"id":999,"name":"Live Theme","role":"live"}]' \
  FAKE_LIST2='[{"id":999,"name":"Live Theme","role":"live"},{"id":777,"name":"PREVIEW-T","role":"unpublished"}]' \
  -- create --name "PREVIEW-T" --no-build || rc=$?
if [ "$rc" -ne 0 ] && grep -q 'error=push_code_failed' "$O" && grep -q 'cause=throttled' "$O" \
   && grep -q '^created_theme=777$' "$O" && grep -q '^created_theme_deleted=failed$' "$O" \
   && [ "$(cpt_calls 'theme delete --store acme-dev --theme 777 --force' "$L")" -eq 1 ]; then ok
else bad P57b-delete-failed-reap "rc=$rc out=$(head -c 200 "$O" | tr '\n' ' ') calls=$(tr '\n' ';' < "$L")"; fi

# N1-N3: a flag given as the LAST arg with no value — each script's need_val stops before any CLI
# or runner call, on its own channel (theme-json/gql: stderr exit 2; create-preview-theme: the
# stdout error= contract, exit 1)
rc=0; L="$TMP/n1"; : > "$L"; M="$TMP/n1.marker"; rm -f "$M"
TJ_GQL_LOG="$L" TJ_CLI_MARKER="$M" PATH="$TJSHIM:$PATH" "$BASH_BIN" "$TJDIR/theme-json.sh" get --theme >"$O" 2>"$E" || rc=$?
assert N1-theme-json-need-val 2 "$rc" "$E" "error=missing_value flag=--theme"
if [ ! -s "$L" ] && [ ! -e "$M" ]; then ok; else bad N1-no-engine "an engine ran before the usage error"; fi
rc=0; L="$TMP/n2"; : > "$L"; M="$TMP/n2.marker"; rm -f "$M"
GQL_LOG="$L" CURL_MARKER="$M" run_gql --query >"$O" 2>"$E" || rc=$?
assert N2-gql-need-val 2 "$rc" "$E" "error=missing_value flag=--query"
if [ ! -s "$L" ] && [ ! -e "$M" ]; then ok; else bad N2-no-engine "an engine ran before the usage error"; fi
rc=0; L="$TMP/n3"; : > "$L"
run_cpt "$L" NO=1 -- refresh --theme || rc=$?
if [ "$rc" -eq 1 ] && grep -q '^error=missing value for --theme$' "$O" && [ ! -s "$L" ]; then ok
else bad N3-cpt-need-val "rc=$rc out=$(head -c 160 "$O" | tr '\n' ' ') log=$(tr '\n' ';' < "$L")"; fi

# ------------------------------------- create-preview-theme.sh session-theme pin --
# `pin` (and `--pin-toml`) REWRITE the developer's shopify.theme.toml, so every case below gets
# its OWN copy: $CPTD/repo/shopify.theme.toml is the config every other cpt case runs against and
# a rewrite in place would silently poison the ones asserting dev_theme_id=111 (P46 proves it did
# not happen). The pinned id has to be a theme the store actually lists, so these run against a
# listing carrying 222 next to the live theme.
PIN_LIST='[{"id":111,"name":"[DEV] Kever","role":"development"},{"id":222,"name":"[ELC-1] session","role":"unpublished"},{"id":999,"name":"Live Theme","role":"live"}]'
fhash() { cksum < "$1"; }

# P29 (pin): the FIRST uncommented `theme =` line takes the session id — the VALUE only, with the
# line's spacing and trailing comment intact — and nothing is pushed. The file two lines down
# holds the Theme Access token: it must survive untouched and never reach the output.
F="$CPTD/toml/pin-basic.toml"
printf '# session config\n[environments.development]\nstore = "acme-dev"\ntheme = "111"   # dev theme\npassword = "shptka_fixture1234"\n' > "$F"
rc=0; L="$TMP/cpt29"; : > "$L"
run_cpt "$L" TOML_PATH="$F" FAKE_LIST="$PIN_LIST" -- pin --theme 222 || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^theme_id=222$' "$O" && grep -q '^pin=rewritten$' "$O" \
   && grep -q '^pin_env=development$' "$O" \
   && grep -q '^commented_dupes=0$' "$O" && grep -q '^pinned_toml=/.*pin-basic\.toml$' "$O" \
   && grep -qx 'theme = "222"   # dev theme' "$F" \
   && [ "$(grep -c 'shptka_fixture1234' "$F")" -eq 1 ] && ! grep -q 'shptka' "$O" "$E" \
   && [ "$(cpt_calls 'theme push' "$L")" -eq 0 ] && [ "$(cpt_calls 'theme pull' "$L")" -eq 0 ]; then ok
else bad P29-pin-rewrites-first "rc=$rc out=$(tr '\n' ';' < "$O") toml=$(grep -v password "$F" | tr '\n' ';')"; fi

# P29b (bug): the id the pin REPLACED is preserved, commented and tagged, right above the pinned
# line — this file is gitignored, so overwriting the shared dev theme id in place would leave it
# recorded nowhere and a mis-pin unrecoverable without hunting it down in the Shopify admin. The
# id is reported too (`superseded_theme_id=`), so the caller can note it.
if grep -qx '# theme = "111"   # dev theme  # fnd:superseded' "$F" \
   && grep -q '^superseded_theme_id=111$' "$O"; then ok
else bad P29b-pin-preserves-old-id "out=$(tr '\n' ';' < "$O") toml=$(grep -v password "$F" | tr '\n' ';')"; fi

# P30 (blocker): a multi-environment toml. `shopify theme dev -e dev` reads `[environments.dev]`,
# NOT the first block in the file — a file-order pin dropped the session id into
# `[environments.production]` (usually the LIVE theme's id, gone for good) and commented out the
# line the dev server actually resolves. The pin is block-scoped: `dev` wins, production is not
# touched at all, and only duplicates INSIDE the target block are commented out.
FM="$CPTD/toml/pin-multi.toml"
printf '[environments.production]\nstore = "acme-dev"\ntheme = "999001"\npassword = "shptka_fixture1234"\n\n[environments.dev]\nstore = "acme-dev"\n# theme = "333"\ntheme = "111"\ntheme = "444"\n' > "$FM"
rc=0; L="$TMP/cpt30"; : > "$L"
run_cpt "$L" TOML_PATH="$FM" FAKE_LIST="$PIN_LIST" -- pin --theme 222 || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^pin=rewritten$' "$O" && grep -q '^pin_env=dev$' "$O" \
   && grep -q '^commented_dupes=1$' "$O" && grep -q '^superseded_theme_id=111$' "$O" \
   && grep -qx 'theme = "999001"' "$FM" && grep -qx 'theme = "222"' "$FM" \
   && [ "$(grep -c '^theme = ' "$FM")" -eq 2 ] \
   && grep -qx '# theme = "111"  # fnd:superseded' "$FM" \
   && grep -qx '# theme = "444"' "$FM" && grep -qx '# theme = "333"' "$FM"; then ok
else bad P30-pin-scoped-to-env "rc=$rc out=$(tr '\n' ';' < "$O") toml=$(grep -v password "$FM" | tr '\n' ';')"; fi

# P30b (blocker): several environment blocks and none named dev/development — there is no way to
# know which one the dev server reads, and guessing writes a preview id over a real environment's
# theme. Refuse by name, change nothing, and say what the escape hatch is.
FAM="$CPTD/toml/pin-ambig.toml"
printf '[environments.production]\nstore = "acme-dev"\ntheme = "999001"\npassword = "shptka_fixture1234"\n\n[environments.staging]\nstore = "acme-dev"\ntheme = "444"\n' > "$FAM"
HAM="$(fhash "$FAM")"
rc=0; L="$TMP/cpt30b"; : > "$L"
run_cpt "$L" TOML_PATH="$FAM" FAKE_LIST="$PIN_LIST" -- pin --theme 222 || rc=$?
if [ "$rc" -ne 0 ] && grep -q 'error=ambiguous_env' "$O" && grep -q -- '--env' "$O" \
   && [ "$(fhash "$FAM")" = "$HAM" ]; then ok
else bad P30b-pin-ambiguous-env "rc=$rc out=$(head -c 200 "$O" | tr '\n' ' ')"; fi

# P30c (blocker): …and `--env <name>` is that escape hatch — it pins the named block and only it
rc=0; L="$TMP/cpt30c"; : > "$L"
run_cpt "$L" TOML_PATH="$FAM" FAKE_LIST="$PIN_LIST" -- pin --theme 222 --env staging || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^pin_env=staging$' "$O" && grep -qx 'theme = "999001"' "$FAM" \
   && grep -qx 'theme = "222"' "$FAM" && grep -qx '# theme = "444"  # fnd:superseded' "$FAM"; then ok
else bad P30c-pin-explicit-env "rc=$rc out=$(tr '\n' ';' < "$O") toml=$(grep -v password "$FAM" | tr '\n' ';')"; fi

# P30d (blocker): a typo in --env must not fall back to "some other block" — nothing is written
HAM2="$(fhash "$FAM")"
rc=0; L="$TMP/cpt30d"; : > "$L"
run_cpt "$L" TOML_PATH="$FAM" FAKE_LIST="$PIN_LIST" -- pin --theme 222 --env nope || rc=$?
if [ "$rc" -ne 0 ] && grep -q 'error=env_not_found' "$O" && grep -q "production staging" "$O" \
   && [ "$(fhash "$FAM")" = "$HAM2" ]; then ok
else bad P30d-pin-env-not-found "rc=$rc out=$(head -c 200 "$O" | tr '\n' ' ')"; fi

# P31 (pin): no uncommented `theme =` line at all — the id is INSERTED after the first
# uncommented `store =` (the environment block the CLI resolves), never at the top of the file
# where it would land outside every block and be ignored. The inserted line carries the
# `# fnd:session-theme` tag: it is session-owned (nothing was superseded), and the tag is what
# lets worktree-setup.sh's unpin delete it and restore the original no-theme state.
FA="$CPTD/toml/pin-append.toml"
printf '[environments.development]\nstore = "acme-dev"\n# theme = "111"\npassword = "shptka_fixture1234"\n' > "$FA"
rc=0; L="$TMP/cpt31"; : > "$L"
run_cpt "$L" TOML_PATH="$FA" FAKE_LIST="$PIN_LIST" -- pin --theme 222 || rc=$?
WANT31='[environments.development]
store = "acme-dev"
theme = "222" # fnd:session-theme
# theme = "111"
password = "shptka_fixture1234"'
if [ "$rc" -eq 0 ] && grep -q '^pin=appended$' "$O" && grep -q '^commented_dupes=0$' "$O" \
   && ! grep -q '^superseded_theme_id=' "$O" \
   && [ "$(cat "$FA")" = "$WANT31" ]; then ok
else bad P31-pin-append "rc=$rc out=$(tr '\n' ';' < "$O") toml=$(grep -v password "$FA" | tr '\n' ';')"; fi

# P31a (blocker): the mirror of P30 for the append path — `store =` at TOP level and the only
# `theme =` commented out inside `[environments.dev]`. Anchoring on the file's first `store =`
# inserted the line at top level, where `-e dev` never reads it: a pin that is a silent no-op for
# the dev server. The block owns the insert; the top-level anchor is not its anchor.
FAT="$CPTD/toml/pin-append-env.toml"
printf 'store = "acme-dev"\npassword = "shptka_fixture1234"\n\n[environments.dev]\n# theme = "111"\n' > "$FAT"
rc=0; L="$TMP/cpt31a"; : > "$L"
run_cpt "$L" TOML_PATH="$FAT" FAKE_LIST="$PIN_LIST" -- pin --theme 222 || rc=$?
WANT31A='store = "acme-dev"
password = "shptka_fixture1234"

[environments.dev]
theme = "222" # fnd:session-theme
# theme = "111"'
if [ "$rc" -eq 0 ] && grep -q '^pin=appended$' "$O" && grep -q '^pin_env=dev$' "$O" \
   && [ "$(cat "$FAT")" = "$WANT31A" ]; then ok
else bad P31a-pin-append-in-block "rc=$rc out=$(tr '\n' ';' < "$O") toml=$(grep -v password "$FAT" | tr '\n' ';')"; fi

# P31b (bug): a config with no `theme` key ANYWHERE. The dev-theme-id guard runs before the
# subcommand dispatch, so pin — the one mode whose job is to repair that exact state — used to
# die on `no uncommented theme = line` before it ever ran.
FA2="$CPTD/toml/pin-notheme.toml"
printf '[environments.development]\nstore = "acme-dev"\npassword = "shptka_fixture1234"\n' > "$FA2"
rc=0; L="$TMP/cpt31b"; : > "$L"
run_cpt "$L" TOML_PATH="$FA2" FAKE_LIST="$PIN_LIST" -- pin --theme 222 || rc=$?
WANT31B='[environments.development]
store = "acme-dev"
theme = "222" # fnd:session-theme
password = "shptka_fixture1234"'
if [ "$rc" -eq 0 ] && grep -q '^pin=appended$' "$O" && [ "$(cat "$FA2")" = "$WANT31B" ]; then ok
else bad P31b-pin-no-theme-key "rc=$rc out=$(tr '\n' ';' < "$O") toml=$(grep -v password "$FA2" | tr '\n' ';')"; fi

# P31c (bug): the same relaxation for a MALFORMED value — `invalid_dev_theme_id` is also a
# pre-dispatch hard stop, and refusing to pin over garbage leaves the developer hand-editing the
# very file the pin exists to fix
FA3="$CPTD/toml/pin-badid.toml"
printf "[environments.development]\nstore = 'acme-dev'\ntheme = 'theme = 111'\npassword = 'shptka_fixture1234'\n" > "$FA3"
rc=0; L="$TMP/cpt31c"; : > "$L"
run_cpt "$L" TOML_PATH="$FA3" FAKE_LIST="$PIN_LIST" -- pin --theme 222 || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^pin=rewritten$' "$O" && grep -qx "theme = '222'" "$FA3"; then ok
else bad P31c-pin-repairs-bad-id "rc=$rc out=$(tr '\n' ';' < "$O") toml=$(grep -v password "$FA3" | tr '\n' ';')"; fi

# P31d (bug): and the relaxation is scoped to `pin` — every OTHER mode still hard-stops on a
# config with no dev theme id, because the settings pull has nothing to pull from
FA4="$CPTD/toml/pin-notheme2.toml"
printf '[environments.development]\nstore = "acme-dev"\npassword = "shptka_fixture1234"\n' > "$FA4"
rc=0; L="$TMP/cpt31d"; : > "$L"
run_cpt "$L" TOML_PATH="$FA4" FAKE_LIST="$PIN_LIST" -- info || rc=$?
OUT31D="$(cat "$O")"
rc2=0; run_cpt "$L" TOML_PATH="$CPTD/toml/badid.toml" -- create --name "PREVIEW-X" --no-build || rc2=$?
if [ "$rc" -ne 0 ] && printf '%s' "$OUT31D" | grep -q 'no uncommented' \
   && [ "$rc2" -ne 0 ] && grep -q 'error=invalid_dev_theme_id' "$O"; then ok
else bad P31d-guards-kept-off-pin "rc=$rc rc2=$rc2 out=$(head -c 160 "$O" | tr '\n' ' ')"; fi

# P32 (pin): re-pinning the SAME id is a byte-for-byte no-op — a skill re-entering a session
# re-pins silently, and a "changed" file there would churn the developer's git status forever.
# A no-op supersedes nothing, so `superseded_theme_id=` must not appear (not even empty-valued):
# the caller records that key as "an id went away" and would note a lie.
H32="$(fhash "$FM")"
rc=0; L="$TMP/cpt32"; : > "$L"
run_cpt "$L" TOML_PATH="$FM" FAKE_LIST="$PIN_LIST" -- pin --theme 222 || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^pin=unchanged$' "$O" && [ "$(fhash "$FM")" = "$H32" ] \
   && ! grep -q '^superseded_theme_id=' "$O"; then ok
else bad P32-pin-idempotent "rc=$rc out=$(tr '\n' ';' < "$O") toml=$(grep -v password "$FM" | tr '\n' ';')"; fi

# P33 (pin): re-pinning a DIFFERENT id swaps cleanly — one uncommented line per block still, the
# other environment is still untouched, and the lines pin #1 commented out stay commented (they
# are not re-commented into `# # theme`)
rc=0; L="$TMP/cpt33"; : > "$L"
run_cpt "$L" TOML_PATH="$FM" FAKE_LIST="$PIN_LIST" -- pin --theme 111 || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^pin=rewritten$' "$O" && grep -q '^commented_dupes=0$' "$O" \
   && [ "$(grep -c '^theme = ' "$FM")" -eq 2 ] && grep -qx 'theme = "111"' "$FM" \
   && grep -qx 'theme = "999001"' "$FM" \
   && grep -qx '# theme = "444"' "$FM" && ! grep -q '# # theme' "$FM"; then ok
else bad P33-pin-repin-new-id "rc=$rc out=$(tr '\n' ';' < "$O") toml=$(grep -v password "$FM" | tr '\n' ';')"; fi

# P33b (bug): the superseded marker records the ORIGINAL value and is never stacked — a second
# re-pin must not push the shared dev theme id out of the file behind a chain of session ids, and
# a second marker line would also cost the byte-idempotence P32 leans on
if [ "$(grep -c 'fnd:superseded' "$FM")" -eq 1 ] \
   && grep -qx '# theme = "111"  # fnd:superseded' "$FM"; then ok
else bad P33b-marker-not-stacked "toml=$(grep -v password "$FM" | tr '\n' ';')"; fi

# P34 (pin): a non-numeric id is refused before any CLI call — the CLI resolves a NAME to any
# theme, and a name written into the config would be re-resolved on every later run
H34="$(fhash "$FM")"
rc=0; L="$TMP/cpt34"; : > "$L"
run_cpt "$L" TOML_PATH="$FM" FAKE_LIST="$PIN_LIST" -- pin --theme "Live Theme" || rc=$?
if [ "$rc" -ne 0 ] && grep -q 'error=invalid_theme_id' "$O" \
   && [ "$(grep -c 'argv=' "$L")" -eq 0 ] && [ "$(fhash "$FM")" = "$H34" ]; then ok
else bad P34-pin-name-refused "rc=$rc out=$(head -c 160 "$O" | tr '\n' ' ')"; fi

# P35 (pin): the live-theme guard covers pin-only mode too — pinning the PUBLISHED theme would
# point `shopify theme dev` at the storefront and sync every save onto it
rc=0; L="$TMP/cpt35"; : > "$L"
run_cpt "$L" TOML_PATH="$FM" FAKE_LIST="$PIN_LIST" -- pin --theme 999 || rc=$?
if [ "$rc" -ne 0 ] && grep -q 'error=live_theme_write_refused' "$O" \
   && [ "$(fhash "$FM")" = "$H34" ]; then ok
else bad P35-pin-live-refused "rc=$rc out=$(head -c 160 "$O" | tr '\n' ' ')"; fi

# P36 (pin): an id absent from a READABLE listing is a typo, and pinning it would break every
# later run (settings pull, info, `theme dev`) with an error naming the config, not the typo
rc=0; L="$TMP/cpt36"; : > "$L"
run_cpt "$L" TOML_PATH="$FM" FAKE_LIST="$PIN_LIST" -- pin --theme 888 || rc=$?
if [ "$rc" -ne 0 ] && grep -q 'error=theme_not_found' "$O" && [ "$(fhash "$FM")" = "$H34" ]; then ok
else bad P36-pin-unknown-id "rc=$rc out=$(head -c 160 "$O" | tr '\n' ' ')"; fi

# P37 (blocker): a `theme list` that never answered leaves the id UNVERIFIABLE — and unlike a
# refresh (one push; a recorded session theme or --allow-unverified gets through, P11), a pin
# PERSISTS in the config, so fail-open would leave a typo pinned until a human notices.
# Standalone `pin` refuses and changes nothing; retry when the store answers.
FO="$CPTD/toml/pin-outage.toml"
printf '[environments.development]\nstore = "acme-dev"\ntheme = "111"\npassword = "shptka_fixture1234"\n' > "$FO"
H37="$(fhash "$FO")"
rc=0; L="$TMP/cpt37"; : > "$L"
run_cpt "$L" TOML_PATH="$FO" FAKE_LIST_FAIL=1 -- pin --theme 888 || rc=$?
if [ "$rc" -ne 0 ] && grep -q 'error=theme_unverifiable' "$O" \
   && ! grep -q '^pin=' "$O" && [ "$(fhash "$FO")" = "$H37" ]; then ok
else bad P37-pin-outage-refused "rc=$rc out=$(tr '\n' ';' < "$O") toml=$(grep -v password "$FO" | tr '\n' ';')"; fi

# P37b: create/refresh --pin-toml hold a REAL theme by pin time, so the same outage must not
# cost the caller the pin (or the id) — the pin lands, but `warn=pin_unvetted` says it was
# never checked against the store, printed BEFORE the pin keys so a caller acting on pin=
# has already seen it. (An unrecorded id needs --allow-unverified to get past
# refresh_unverifiable at all — P11.)
rc=0; L="$TMP/cpt37b"; : > "$L"
run_cpt "$L" TOML_PATH="$FO" FAKE_LIST_FAIL=1 -- refresh --theme 222 --no-build --pin-toml --allow-unverified || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^theme_id=222$' "$O" && grep -q '^warn=pin_unvetted$' "$O" \
   && grep -q '^pin=rewritten$' "$O" && grep -qx 'theme = "222"' "$FO" \
   && [ "$(grep -n '^warn=pin_unvetted$' "$O" | cut -d: -f1)" -lt "$(grep -n '^pinned_toml=' "$O" | cut -d: -f1)" ]; then ok
else bad P37b-pin-toml-outage-unvetted "rc=$rc out=$(tr '\n' ';' < "$O") toml=$(grep -v password "$FO" | tr '\n' ';')"; fi

# P38 (pin): a Windows-edited config keeps its CRLF endings — a rewrite that dropped the CR on
# one line only would leave a mixed-ending file the developer's diff cannot explain
FC="$CPTD/toml/pin-crlf.toml"
printf '[environments.development]\r\nstore = "acme-dev"\r\ntheme = "111"\r\npassword = "shptka_fixture1234"\r\n' > "$FC"
rc=0; L="$TMP/cpt38"; : > "$L"
run_cpt "$L" TOML_PATH="$FC" FAKE_LIST="$PIN_LIST" -- pin --theme 222 || rc=$?
CR38="$(tr -cd '\r' < "$FC" | wc -c | tr -d ' ')"; LF38="$(tr -cd '\n' < "$FC" | wc -c | tr -d ' ')"
# 5 lines now: the superseded marker the rewrite inserts carries the file's endings too
if [ "$rc" -eq 0 ] && [ "$CR38" -eq 5 ] && [ "$LF38" -eq 5 ] \
   && grep -q 'theme = "222"' "$FC" && grep -q '# theme = "111"  # fnd:superseded' "$FC"; then ok
else bad P38-pin-crlf "rc=$rc cr=$CR38 lf=$LF38 out=$(tr '\n' ';' < "$O")"; fi

# P39 (pin): the quoting style is the developer's — a single-quoted value stays single-quoted,
# so a re-pin of the same id can stay a byte-for-byte no-op (P32) whatever the file looks like
FQ="$CPTD/toml/pin-quote.toml"
printf "[environments.development]\nstore = 'acme-dev'\ntheme = '111'\npassword = 'shptka_fixture1234'\n" > "$FQ"
rc=0; L="$TMP/cpt39"; : > "$L"
run_cpt "$L" TOML_PATH="$FQ" FAKE_LIST="$PIN_LIST" -- pin --theme 222 || rc=$?
if [ "$rc" -eq 0 ] && grep -qx "theme = '222'" "$FQ" \
   && grep -qx "# theme = '111'  # fnd:superseded" "$FQ"; then ok
else bad P39-pin-single-quote "rc=$rc toml=$(grep -v password "$FQ" | tr '\n' ';')"; fi

# P39b (pin): and a BARE value stays bare, with its trailing comment where it was
FB2="$CPTD/toml/pin-bare.toml"
printf '[environments.development]\nstore = acme-dev\ntheme = 111  # dev\npassword = "shptka_fixture1234"\n' > "$FB2"
rc=0; L="$TMP/cpt39b"; : > "$L"
run_cpt "$L" TOML_PATH="$FB2" FAKE_LIST="$PIN_LIST" -- pin --theme 222 || rc=$?
if [ "$rc" -eq 0 ] && grep -qx 'theme = 222  # dev' "$FB2" \
   && grep -qx '# theme = 111  # dev  # fnd:superseded' "$FB2"; then ok
else bad P39b-pin-bare "rc=$rc toml=$(grep -v password "$FB2" | tr '\n' ';')"; fi

# P40 (pin): a file whose last byte is not a newline must not gain one — that alone would make
# the next re-pin a "change" and break the idempotence the re-entry rule leans on
FN="$CPTD/toml/pin-nonl.toml"
printf '[environments.development]\nstore = "acme-dev"\npassword = "shptka_fixture1234"\ntheme = "111"' > "$FN"
rc=0; L="$TMP/cpt40"; : > "$L"
run_cpt "$L" TOML_PATH="$FN" FAKE_LIST="$PIN_LIST" -- pin --theme 222 || rc=$?
H40="$(fhash "$FN")"
rc2=0; run_cpt "$L" TOML_PATH="$FN" FAKE_LIST="$PIN_LIST" -- pin --theme 222 || rc2=$?
if [ "$rc" -eq 0 ] && [ "$rc2" -eq 0 ] && grep -q '^pin=unchanged$' "$O" \
   && [ -n "$(tail -c 1 "$FN")" ] && grep -qx 'theme = "222"' "$FN" \
   && [ "$(fhash "$FN")" = "$H40" ]; then ok
else bad P40-pin-no-trailing-newline "rc=$rc rc2=$rc2 toml=$(grep -v password "$FN" | tr '\n' ';')"; fi

# P41 (pin): `create --pin-toml` end to end — the theme keys still come first (a caller that
# lost the id could not clean the theme up), then the pin keys, and the config now holds it
FCR="$CPTD/toml/pin-create.toml"
printf '[environments.development]\nstore = "acme-dev"\ntheme = "111"\npassword = "shptka_fixture1234"\n' > "$FCR"
rc=0; L="$TMP/cpt41"; : > "$L"
run_cpt "$L" TOML_PATH="$FCR" -- create --name "PREVIEW-PIN" --no-build --pin-toml || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^theme_id=222$' "$O" && grep -q '^pin=rewritten$' "$O" \
   && grep -qx 'theme = "222"' "$FCR" \
   && [ "$(grep -n '^theme_id=' "$O" | cut -d: -f1)" -lt "$(grep -n '^pin=' "$O" | cut -d: -f1)" ]; then ok
else bad P41-create-pin-toml "rc=$rc out=$(tr '\n' ';' < "$O") toml=$(grep -v password "$FCR" | tr '\n' ';')"; fi

# P41b (bug): `create --pin-toml` used to pin whatever `--json` handed back, unvetted. A
# gid-shaped id (a shape this store's listings really do use — see the unusable_theme_id case)
# written into the config bricks every later run of the script with `invalid_dev_theme_id`, in a
# gitignored file only a hand edit repairs. The id is re-vetted first, and a non-numeric one is a
# reported pin FAILURE — the run still succeeds and still prints the theme id, since the theme is
# real by then and a caller that lost it cannot clean it up.
FGID="$CPTD/toml/pin-gid.toml"
printf '[environments.development]\nstore = "acme-dev"\ntheme = "111"\npassword = "shptka_fixture1234"\n' > "$FGID"
HGID="$(fhash "$FGID")"
rc=0; L="$TMP/cpt41b"; : > "$L"
run_cpt "$L" TOML_PATH="$FGID" \
  FAKE_PUSH_JSON='{"theme":{"id":"gid://shopify/OnlineStoreTheme/700","preview_url":"https://x","editor_url":"https://y"}}' \
  -- create --name "PREVIEW-GID" --no-build --pin-toml || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^theme_id=gid://shopify/OnlineStoreTheme/700$' "$O" \
   && grep -q '^pin=failed$' "$O" && grep -q '^pin_error=.*non-numeric theme id' "$O" \
   && [ "$(fhash "$FGID")" = "$HGID" ]; then ok
else bad P41b-create-pin-rejects-gid "rc=$rc out=$(tr '\n' ';' < "$O") toml=$(grep -v password "$FGID" | tr '\n' ';')"; fi

# P42 (pin): `refresh --pin-toml` pins the id it was pointed at, so a QA refresh of the session
# theme re-asserts the pin instead of leaving the config on whatever was there before
FRF="$CPTD/toml/pin-refresh.toml"
printf '[environments.development]\nstore = "acme-dev"\ntheme = "111"\npassword = "shptka_fixture1234"\n' > "$FRF"
rc=0; L="$TMP/cpt42"; : > "$L"
run_cpt "$L" TOML_PATH="$FRF" FAKE_LIST="$PIN_LIST" -- refresh --theme 222 --no-build --pin-toml || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^theme_id=222$' "$O" && grep -q '^pin=rewritten$' "$O" \
   && grep -q '^commented_dupes=0$' "$O" && grep -qx 'theme = "222"' "$FRF"; then ok
else bad P42-refresh-pin-toml "rc=$rc out=$(tr '\n' ';' < "$O") toml=$(grep -v password "$FRF" | tr '\n' ';')"; fi

# P48 (blocker): the appended pin line is exactly `theme = "<id>" # fnd:session-theme` — and a
# same-id re-pin on the tagged line stays a byte-for-byte no-op (the tag must not break the
# idempotence P32 established for the rewrite path)
F48="$CPTD/toml/pin-tag.toml"
printf '[environments.development]\nstore = "acme-dev"\npassword = "shptka_fixture1234"\n' > "$F48"
rc=0; L="$TMP/cpt48"; : > "$L"
run_cpt "$L" TOML_PATH="$F48" FAKE_LIST="$PIN_LIST" -- pin --theme 222 || rc=$?
H48="$(fhash "$F48")"
rc2=0; run_cpt "$L" TOML_PATH="$F48" FAKE_LIST="$PIN_LIST" -- pin --theme 222 || rc2=$?
if [ "$rc" -eq 0 ] && [ "$rc2" -eq 0 ] && grep -q '^pin=unchanged$' "$O" \
   && grep -qx 'theme = "222" # fnd:session-theme' "$F48" \
   && ! grep -q 'fnd:superseded' "$F48" && [ "$(fhash "$F48")" = "$H48" ]; then ok
else bad P48-append-session-tag "rc=$rc rc2=$rc2 out=$(tr '\n' ';' < "$O") toml=$(grep -v password "$F48" | tr '\n' ';')"; fi

# P48b (blocker): re-pinning a DIFFERENT id onto a tagged line swaps the value, KEEPS the tag and
# writes NO fnd:superseded marker — the line is session-owned, the block's original state had no
# `theme =` at all, so there is nothing to supersede and unpin must still simply delete the line
rc=0; L="$TMP/cpt48b"; : > "$L"
run_cpt "$L" TOML_PATH="$F48" FAKE_LIST="$PIN_LIST" -- pin --theme 111 || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^pin=rewritten$' "$O" \
   && grep -qx 'theme = "111" # fnd:session-theme' "$F48" \
   && ! grep -q 'fnd:superseded' "$F48"; then ok
else bad P48b-repin-keeps-tag-no-marker "rc=$rc out=$(tr '\n' ';' < "$O") toml=$(grep -v password "$F48" | tr '\n' ';')"; fi

# P49 (bug): only a REAL marker line (`# theme = … # fnd:superseded`) counts as "this block is
# already pinned" — a stray comment merely containing the string used to suppress the marker, so
# a real pin overwrote the dev theme id with NO commented copy left to restore
F49="$CPTD/toml/pin-stray.toml"
printf '[environments.development]\nstore = "acme-dev"\n# NB fnd:superseded markers are plugin-managed\ntheme = "111"\npassword = "shptka_fixture1234"\n' > "$F49"
rc=0; L="$TMP/cpt49"; : > "$L"
run_cpt "$L" TOML_PATH="$F49" FAKE_LIST="$PIN_LIST" -- pin --theme 222 || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^superseded_theme_id=111$' "$O" \
   && grep -qx '# theme = "111"  # fnd:superseded' "$F49" \
   && grep -qx '# NB fnd:superseded markers are plugin-managed' "$F49" \
   && grep -qx 'theme = "222"' "$F49"; then ok
else bad P49-stray-marker-comment "rc=$rc out=$(tr '\n' ';' < "$O") toml=$(grep -v password "$F49" | tr '\n' ';')"; fi

# P50 (blocker): a SINGLE block not named dev/development is no longer auto-picked — the count
# proves nothing about which environment `shopify theme dev -e <name>` reads, and a lone
# [environments.production] usually names the LIVE theme's id. Refused without --env, nothing
# written; --env production is the explicit escape hatch.
F50="$CPTD/toml/pin-single-prod.toml"
printf '[environments.production]\nstore = "acme-dev"\ntheme = "999001"\npassword = "shptka_fixture1234"\n' > "$F50"
H50="$(fhash "$F50")"
rc=0; L="$TMP/cpt50"; : > "$L"
run_cpt "$L" TOML_PATH="$F50" FAKE_LIST="$PIN_LIST" -- pin --theme 222 || rc=$?
OUT50="$(cat "$O")"; UNTOUCHED50=no; [ "$(fhash "$F50")" = "$H50" ] && UNTOUCHED50=yes
rc2=0; run_cpt "$L" TOML_PATH="$F50" FAKE_LIST="$PIN_LIST" -- pin --theme 222 --env production || rc2=$?
if [ "$rc" -ne 0 ] && printf '%s' "$OUT50" | grep -q 'error=ambiguous_env' \
   && printf '%s' "$OUT50" | grep -q -- '--env' \
   && [ "$UNTOUCHED50" = "yes" ] \
   && [ "$rc2" -eq 0 ] && grep -q '^pin_env=production$' "$O" \
   && grep -qx 'theme = "222"' "$F50" \
   && grep -qx '# theme = "999001"  # fnd:superseded' "$F50"; then ok
else bad P50-single-nondev-block "rc=$rc rc2=$rc2 untouched=$UNTOUCHED50 out=$(printf '%s' "$OUT50" | head -c 160 | tr '\n' ' ') toml=$(grep -v password "$F50" | tr '\n' ';')"; fi

# P51 (pin): a toml with no [environments.*] at all pins the top-level keys and says so —
# pin_env=- is the sentinel a caller can trust (no block name can ever be `-`)
F51="$CPTD/toml/pin-toplevel.toml"
printf 'store = "acme-dev"\ntheme = "111"\npassword = "shptka_fixture1234"\n' > "$F51"
rc=0; L="$TMP/cpt51"; : > "$L"
run_cpt "$L" TOML_PATH="$F51" FAKE_LIST="$PIN_LIST" -- pin --theme 222 || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^pin=rewritten$' "$O" && grep -q '^pin_env=-$' "$O" \
   && grep -qx 'theme = "222"' "$F51" \
   && grep -qx '# theme = "111"  # fnd:superseded' "$F51"; then ok
else bad P51-pin-toplevel "rc=$rc out=$(tr '\n' ';' < "$O") toml=$(grep -v password "$F51" | tr '\n' ';')"; fi

# P51b (pin): …and when blocks exist but none is named dev/development, an uncommented top-level
# `theme =` BEFORE the first header is the fallback the ambiguity check yields to — the top-level
# line is what a bare `shopify theme dev` reads, and the named blocks stay untouched
F51B="$CPTD/toml/pin-toplevel-fb.toml"
printf 'theme = "111"\n\n[environments.production]\nstore = "acme-dev"\ntheme = "999001"\npassword = "shptka_fixture1234"\n' > "$F51B"
rc=0; L="$TMP/cpt51b"; : > "$L"
run_cpt "$L" TOML_PATH="$F51B" FAKE_LIST="$PIN_LIST" -- pin --theme 222 || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^pin=rewritten$' "$O" && grep -q '^pin_env=-$' "$O" \
   && grep -qx 'theme = "222"' "$F51B" && grep -qx 'theme = "999001"' "$F51B" \
   && grep -qx '# theme = "111"  # fnd:superseded' "$F51B"; then ok
else bad P51b-toplevel-fallback "rc=$rc out=$(tr '\n' ';' < "$O") toml=$(grep -v password "$F51B" | tr '\n' ';')"; fi

# P52 (bug): --env only ever feeds the pin — accepted without --pin-toml it would be a silent
# no-op the caller reads as "the block I named was pinned". Refused on create and refresh alike,
# before any CLI call.
rc=0; L="$TMP/cpt52"; : > "$L"
run_cpt "$L" NO=1 -- refresh --theme 111 --no-build --env dev || rc=$?
OUT52="$(cat "$O")"
rc2=0; run_cpt "$L" NO=1 -- create --name "PREVIEW-ENV" --no-build --env dev || rc2=$?
if [ "$rc" -ne 0 ] && printf '%s' "$OUT52" | grep -q 'error=--env requires --pin-toml' \
   && [ "$rc2" -ne 0 ] && grep -q 'error=--env requires --pin-toml' "$O" \
   && [ ! -s "$L" ]; then ok
else bad P52-env-requires-pin-toml "rc=$rc rc2=$rc2 out=$(head -c 160 "$O" | tr '\n' ' ') calls=$(tr '\n' ';' < "$L")"; fi

# P43 (bug): a pin that CANNOT be written after a real theme was created must not take the run
# non-zero — the theme exists on the store by then, and a caller that never got `theme_id=`
# cannot reuse or delete it. Read-only directory = mktemp fails = the config is left alone.
PRO="$TMP/pin-ro"; mkdir -p "$PRO"; FRO="$PRO/shopify.theme.toml"
printf '[environments.development]\nstore = "acme-dev"\ntheme = "111"\npassword = "shptka_fixture1234"\n' > "$FRO"
HRO="$(fhash "$FRO")"; chmod 555 "$PRO"
rc=0; L="$TMP/cpt43"; : > "$L"
run_cpt "$L" TOML_PATH="$FRO" -- create --name "PREVIEW-PIN2" --no-build --pin-toml || rc=$?
chmod 755 "$PRO"
if [ "$rc" -eq 0 ] && grep -q '^theme_id=222$' "$O" && grep -q '^pin=failed$' "$O" \
   && grep -q '^pin_error=' "$O" && [ "$(fhash "$FRO")" = "$HRO" ] \
   && [ "$(ls -a "$PRO" | grep -c 'fnd-pin')" -eq 0 ]; then ok
else bad P43-create-pin-failure-nonfatal "rc=$rc out=$(tr '\n' ';' < "$O") left=$(ls -a "$PRO" | tr '\n' ' ')"; fi

# P44 (pin): standalone `pin` has nothing else to report, so the same write failure IS the
# result — it exits non-zero with error=pin_toml_failed and leaves the config untouched
chmod 555 "$PRO"
rc=0; L="$TMP/cpt44"; : > "$L"
run_cpt "$L" TOML_PATH="$FRO" FAKE_LIST="$PIN_LIST" -- pin --theme 222 || rc=$?
chmod 755 "$PRO"
if [ "$rc" -ne 0 ] && grep -q 'error=pin_toml_failed' "$O" && [ "$(fhash "$FRO")" = "$HRO" ] \
   && [ "$(ls -a "$PRO" | grep -c 'fnd-pin')" -eq 0 ]; then ok
else bad P44-pin-write-failure "rc=$rc out=$(head -c 200 "$O" | tr '\n' ' ') left=$(ls -a "$PRO" | tr '\n' ' ')"; fi

# P45 (pin): the rewrite stages its temp file NEXT TO the config (same dir = an atomic rename
# that cannot cross a filesystem), so every run must take that dot-file away with it
if [ "$(ls -a "$CPTD/toml" | grep -c 'fnd-pin')" -eq 0 ]; then ok
else bad P45-pin-no-temp-leftovers "left=$(ls -a "$CPTD/toml" | tr '\n' ' ')"; fi

# P46 (pin): TOML_PATH is the only file any of the cases above touched — the repo's own config
# still resolves to the fixture dev theme
rc=0; L="$TMP/cpt46"; : > "$L"; run_cpt "$L" NO=1 -- info || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^dev_theme_id=111$' "$O"; then ok
else bad P46-repo-toml-untouched "rc=$rc out=$(tr '\n' ';' < "$O")"; fi

# P47 (bug): a SYMLINKED config is followed to its target — the atomic rename would otherwise
# replace the link with a regular file and unpin whatever the developer pointed it at. Its mode
# survives too: the file holds the Theme Access token and mktemp hands out 0600.
PSD="$TMP/pin-link"; mkdir -p "$PSD"
printf '[environments.development]\nstore = "acme-dev"\ntheme = "111"\npassword = "shptka_fixture1234"\n' > "$PSD/real.toml"
chmod 640 "$PSD/real.toml"; ln -sf real.toml "$PSD/link.toml"
rc=0; L="$TMP/cpt47"; : > "$L"
run_cpt "$L" TOML_PATH="$PSD/link.toml" FAKE_LIST="$PIN_LIST" -- pin --theme 222 || rc=$?
if [ "$rc" -eq 0 ] && [ -L "$PSD/link.toml" ] && grep -qx 'theme = "222"' "$PSD/real.toml" \
   && [ "$(ls -l "$PSD/real.toml" | cut -c1-10)" = "-rw-r-----" ]; then ok
else bad P47-pin-symlinked-toml "rc=$rc link=$(ls -l "$PSD" | tr '\n' ';')"; fi

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

# L2b (bug): the same decline on a payload PIPED in as a stdin device — the stream is spent by the
# time the caller reads the advice, so naming the device back is advice nobody can follow. Every
# spelling of that device counts: the caller chooses which one it passes.
for dev in /dev/stdin /dev/fd/0 /proc/self/fd/0; do
  [ -e "$dev" ] || continue   # Linux-only on /proc, and some sandboxes hide /dev/fd
  rc=0; FND_MCP_SLIM_DIR="$LOGD" node "$SLIM" "$dev" <"$DOCF" >"$O" 2>"$E" || rc=$?
  if [ "$rc" -eq 0 ] && grep -Fq 'came in on stdin' "$O" && grep -Fq -- '--jq' "$O" \
     && ! grep -Fq "$dev" "$O"; then ok
  else bad "L2b-stdin-handback-$dev" "rc=$rc head=$(head -c 200 "$O")"; fi
done

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
   && grep -Fq 'never read by any tool): 1 of 2' "$O" \
   && printf '%s' "$missed" | grep -Fq 'lonely-whale.txt' \
   && ! printf '%s' "$missed" | grep -Fq 'paired-whale.txt' \
   && grep -Fq 'elc:' "$O" && grep -Fq 'other:' "$O" \
   && grep -Fq 'cli runs: 1 · saved 641076 B (83.9%)' "$O"; then ok
else bad R1-report "rc=$rc lines=$lines out=$(head -c 400 "$O") err=$(head -c 120 "$E")"; fi

# R1b (bug): the two halves against each other — hooks/spill-access.sh records the read, --report
# pairs it. A command naming the spill RELATIVE to its cwd is the same recovery as an absolute one,
# so the whale must come back paired; recorded truncated it never could.
RPD2="$TMP/report-rel"; mkdir -p "$RPD2"
RPLOG2="$RPD2/fnd-mcp-slim-debug.log"
cat > "$RPLOG2" <<'RPEOF'
{"ts":"2026-01-01T09:00:00.000Z","project":"elc","lvl":1,"entry":"hook","tool":"mcp__x__get_metadata","decision":"passthrough","reason":"platform-overflow","bytes_in":1400,"bytes_out":1400,"pct":0,"stages":[],"spill":"/r/elc/.claude/fnd-tmp/tool-results/b1z10evqs.txt","ms":1}
RPEOF
printf '%s' '{"cwd":"/r/elc","tool_name":"Bash","tool_input":{"command":"jq . .claude/fnd-tmp/tool-results/b1z10evqs.txt"}}' \
  | env FND_MCP_SLIM_DIR="$RPD2" FND_MCP_SLIM_DEBUG=1 "$ROOT/plugins/fnd/hooks/spill-access.sh" >/dev/null 2>&1
rc=0; node "$SLIM" --report "$RPLOG2" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -Fq 'never read by any tool): 0 of 1' "$O" \
   && grep -Fq 'whale recoveries via: jq 1' "$O"; then ok
else bad R1b-relative-access-pairs "rc=$rc log=$(tr '\n' ';' < "$RPLOG2") out=$(head -c 300 "$O")"; fi

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

# R4b: the ≤ 40-line promise is made about a report with EVERY optional section populated, and the log
# R1 measures has no access events — so the two M16 lines it grew (`spill reads`, `whale recoveries
# via`) were never inside the length anyone checked. This log fills them all: six hook tools and six
# projects (both rankings truncate), a cli aggregate, a stub, mixed collection levels, spill
# inventories, nine overflows so the missed list is long, and access reads that recover two of them.
RPLOG4="$RPD/full.log"
: > "$RPLOG4"
for i in 1 2 3 4 5 6; do
  printf '{"ts":"2026-08-25T0%s:00:00.000Z","project":"p%s","lvl":2,"entry":"hook","tool":"mcp__a__t%s","decision":"compressed","reason":null,"bytes_in":90000,"bytes_out":%s0000,"pct":50,"stages":["adf","noise","crush"],"spill":"/tmp/fnd-mcp-slim-h%s.json","spills":["/tmp/fnd-crush-%s.json"],"spills_n":3,"ms":5}\n' "$i" "$i" "$i" "$i" "$i" "$i" >> "$RPLOG4"
done
for i in 1 2 3 4 5 6 7 8 9; do
  printf '{"ts":"2026-08-25T1%s:00:00.000Z","project":"p1","lvl":1,"entry":"hook","tool":"mcp__x__evaluate_script","decision":"passthrough","reason":"platform-overflow","bytes_in":1463,"bytes_out":1463,"pct":0,"stages":[],"spill":"/p/tool-results/w%s.txt","ms":1}\n' "$i" "$i" >> "$RPLOG4"
done
cat >> "$RPLOG4" <<'RPEOF'
{"ts":"2026-08-25T20:00:00.000Z","project":"p1","lvl":2,"entry":"cli","tool":"/p/tool-results/w1.txt","decision":"compressed","reason":null,"bytes_in":800000,"bytes_out":90000,"pct":88.8,"stages":["crush"],"spill":null,"spill_out":"/tmp/fnd-slim-out-a.json","ms":40}
{"ts":"2026-08-25T20:05:00.000Z","project":"p1","lvl":2,"entry":"access","tool":"Bash","via":"jq","spill":"/p/tool-results/w2.txt"}
{"ts":"2026-08-25T20:06:00.000Z","project":"p1","lvl":2,"entry":"access","tool":"Read","via":"read","spill":"/p/tool-results/w3.txt"}
{"ts":"2026-08-25T20:10:00.000Z","project":"p2","lvl":2,"entry":"hook","tool":"mcp__a__getJiraIssue","decision":"stubbed","reason":"weak-gain","bytes_in":260000,"bytes_out":910,"pct":99.6,"stages":["adf"],"spill":"/tmp/fnd-mcp-slim-s1.json","ms":33}
{"ts":"2026-08-25T20:20:00.000Z","project":"p3","lvl":2,"entry":"hook","tool":"mcp__a__listFiles","decision":"passthrough","reason":"non-json","bytes_in":52518,"bytes_out":52518,"pct":0,"stages":[],"spill":null,"ms":2}
RPEOF
rc=0; node "$SLIM" --report "$RPLOG4" >"$O" 2>"$E" || rc=$?
lines=$(wc -l < "$O" | tr -d ' ')
if [ "$rc" -eq 0 ] && [ "$lines" -le 40 ] \
   && grep -Fq 'spill reads (access hook): 2' "$O" && grep -Fq 'whale recoveries via:' "$O" \
   && grep -Fq 'never read by any tool): 6 of 9' "$O" \
   && grep -Fq 'MIXED levels' "$O" && grep -Fq 'stubbed (spill-and-stub guard)' "$O"; then ok
else bad R4b-report-length-every-section "rc=$rc lines=$lines out=$(cat "$O")"; fi

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
   && grep -Fq 'stubbed (spill-and-stub guard): 2 (non-json 1 · weak-gain 1), 1 never read' "$O" \
   && grep -Fq 'never read by any tool): 0 of 0' "$O" \
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
   && grep -Fq 'never read by any tool): 0 of 0' "$O"; then ok
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
if [ "$rc" -eq 0 ] && grep -Fq '0 never read, 1 whose run gained nothing' "$O" \
   && grep -Fq 'cli runs: 1 · saved 0 B (0.0%) · 1 gained nothing' "$O"; then ok
else bad R8e-flat-followup "rc=$rc out=$(head -c 500 "$O")"; fi
# …but a `--jq` run that reduced nothing ANSWERED a sub-path (it printed one field, not the file) — that is
# the recovery the stub now names, so it must not be counted as the re-dump this line exists to expose.
RPLOG7="$RPD/narrowed-followup.log"
head -1 "$RPLOG6" > "$RPLOG7"
printf '%s\n' '{"ts":"2026-07-25T22:02:00.000Z","project":"elc","lvl":1,"entry":"cli","tool":"/tmp/fnd-mcp-slim-f.json","decision":"passthrough","reason":"no-gain","narrowed":true,"bytes_in":160,"bytes_out":160,"pct":0,"stages":[],"spill":null,"ms":2}' >> "$RPLOG7"
rc=0; node "$SLIM" --report "$RPLOG7" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -Fq '0 never read' "$O" \
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
   && grep -Fq '0 never read' "$O"; then ok
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

# ---------------------------------------------- worktree-setup.sh against a scratch git repo --
# Hermetic git: the developer's ~/.gitconfig (user.*, commit.gpgsign, core.hooksPath,
# init.templateDir) must never reach these fixtures, so every git call — the harness's and the
# script's own — runs with HOME pinned inside $TMP and an explicit identity. `origin` is a second
# LOCAL bare repo, so nothing here touches the network.
# NB worktree-setup.sh prints error= on STDOUT, not stderr — every case greps $O.
WTS="$ROOT/plugins/fnd/scripts/worktree-setup.sh"
WTR="$TMP/wt"; mkdir -p "$WTR/home" "$WTR/shim"
wt_git() { HOME="$WTR/home" GIT_CONFIG_NOSYSTEM=1 git \
             -c init.defaultBranch=develop -c user.name=fnd -c user.email=fnd@example.com \
             -c commit.gpgsign=false "$@"; }
wt_run() { # wt_run <args…>   ; stdout -> $O, stderr -> $E
  (cd "$WTR/theme" && HOME="$WTR/home" GIT_CONFIG_NOSYSTEM=1 PATH="$WTR/shim:$PATH" \
     "$BASH_BIN" "$WTS" "$@") >"$O" 2>"$E"
}
wt_branch() { wt_git -C "$1" rev-parse --abbrev-ref HEAD 2>/dev/null || true; }
wt_key() { grep "^$1=" "$O" | head -1 | cut -d= -f2- ; }

# A REAL listener on 127.0.0.1:$1, polled until it accepts — the port probe under test talks to
# the loopback stack, so nothing short of an open socket exercises it.
wt_wait_port() { # blocks until 127.0.0.1:$1 accepts (5 s cap)
  local i=0
  while [ "$i" -lt 50 ] && ! node -e '
    const s=require("net").connect(Number(process.argv[1]),"127.0.0.1");
    s.on("connect",()=>process.exit(0)); s.on("error",()=>process.exit(1));' "$1" 2>/dev/null; do
    sleep 0.1; i=$((i + 1))
  done
}
wt_listen() {
  node -e 'require("net").createServer().listen(Number(process.argv[1]),"127.0.0.1")' "$1" &
  WPID=$!
  wt_wait_port "$1"
}
wt_listen2() { # a second listener alongside wt_listen's (the no_free_port case needs two)
  node -e 'require("net").createServer().listen(Number(process.argv[1]),"127.0.0.1")' "$1" &
  WPID2=$!
  wt_wait_port "$1"
}
wt_unlisten() {
  local p
  for p in "$WPID" "$WPID2"; do
    [ -n "$p" ] || continue
    kill "$p" 2>/dev/null; wait "$p" 2>/dev/null
  done
  WPID=""; WPID2=""
}
# The port the script would pick next: the lowest in its range no workspace has recorded yet. A
# case that wants the live probe tested has to occupy a port the recorded-port bookkeeping does
# NOT already exclude, or it proves nothing.
wt_next_port() {
  local p=9293
  while [ "$p" -le 9312 ] && grep -rqE "dev-port: $p\$" "$WTR/theme/.claude/tasks" 2>/dev/null; do
    p=$((p + 1))
  done
  printf '%s' "$p"
}

wt_git init --bare -q "$WTR/origin.git"
wt_git init -q "$WTR/theme"
printf 'x\n' > "$WTR/theme/README.md"
wt_git -C "$WTR/theme" add -A
wt_git -C "$WTR/theme" commit -qm init
wt_git -C "$WTR/theme" remote add origin "$WTR/origin.git"
wt_git -C "$WTR/theme" push -qu origin develop
# Untracked on purpose, and NOT hidden in .git/info/exclude: a real repo gitignores the toml
# (it carries the Theme Access token) and the `.claude` wiring, so both land in the worktree as
# untracked paths — which is exactly what the remove-mode dirty check has to look past.
printf '[environments.development]\nstore = "acme-dev"\ntheme = "111"\n' > "$WTR/theme/shopify.theme.toml"
printf 'SHOPIFY_ADMIN_TOKEN=shpat_fixture\n' > "$WTR/theme/.env"
mkdir -p "$WTR/theme/.claude"
printf '{"permissions":{"allow":["Bash(ls:*)"]}}\n' > "$WTR/theme/.claude/settings.local.json"
# npm must never really run (no network, and the fixture deliberately has no package.json);
# the shim logs every call so "npm never ran" is assertable rather than inferred.
# WT_NPM_WAIT holds `npm ci` until that file exists (a setup frozen mid-install, W31);
# WT_NPM_NOTES logs how many `dev-port:` lines that notes file carries at install time (W31b).
cat > "$WTR/shim/npm" <<'FAKE'
#!/usr/bin/env bash
printf 'argv=%s\n' "$*" >> "${WT_NPM_LOG:-/dev/null}"
if [ -n "${WT_NPM_WAIT:-}" ]; then
  i=0; while [ ! -f "$WT_NPM_WAIT" ] && [ "$i" -lt 100 ]; do sleep 0.1; i=$((i + 1)); done
fi
[ -z "${WT_NPM_NOTES:-}" ] || \
  printf 'dev-port-lines=%s\n' "$(grep -c 'dev-port:' "$WT_NPM_NOTES" 2>/dev/null)" >> "${WT_NPM_LOG:-/dev/null}"
exit 0
FAKE
chmod +x "$WTR/shim/npm"
WT_NPM_LOG="$WTR/npm.log"; : > "$WT_NPM_LOG"; export WT_NPM_LOG
# The script reports git's PHYSICAL paths, and $TMP under /var/folders reaches them through the
# /var → /private/var symlink — comparing against $WTR verbatim would fail on every macOS run.
WTMAIN="$(cd "$WTR/theme" && pwd -P)"

# W1: a fresh ticket-key run creates the sibling worktree on feat/<KEY> off origin/develop and
# copies (never links) the store config into it
rc=0; wt_run ABC-123 || rc=$?
W1DIR="$WTR/theme-ABC-123"
if [ "$rc" -eq 0 ] && [ -d "$W1DIR" ] && [ "$(wt_branch "$W1DIR")" = "feat/ABC-123" ] \
   && [ -f "$W1DIR/shopify.theme.toml" ] && [ ! -L "$W1DIR/shopify.theme.toml" ] \
   && [ "$(wt_key worktree)" = "$(cd "$W1DIR" && pwd -P)" ] \
   && grep -q '^branch_source=created$' "$O" && grep -q '^reused=false$' "$O" \
   && grep -q '^toml=copied$' "$O"; then ok
else bad W1-fresh-create "rc=$rc out=$(tr '\n' ';' < "$O") err=$(head -c 200 "$E" | tr '\n' ' ')"; fi

# W2: the hand-off block is part of the output — the skill relays it verbatim, so a run that
# creates the worktree but prints no launch line leaves the developer stranded
W1PORT="$(wt_key dev_port)"; W1DIRP="$(cd "$W1DIR" && pwd -P)"
if grep -qF "cd '$W1DIRP' && claude" "$O" && grep -q '/fnd:ship ABC-123' "$O" \
   && printf '%s' "$W1PORT" | grep -qE '^9[0-9]+$'; then ok
else bad W2-handoff-block "port=$W1PORT out=$(tr '\n' ';' < "$O")"; fi

# W3: `.claude/tasks` is a symlink INTO the main checkout (one shared task workspace for both
# sessions), while settings.local.json is a real copy — sharing it live would let two sessions
# overwrite each other's permission approvals
if [ -L "$W1DIR/.claude/tasks" ] \
   && [ "$(cd "$W1DIR/.claude/tasks" && pwd -P)" = "$(cd "$WTR/theme/.claude/tasks" && pwd -P)" ] \
   && [ -f "$W1DIR/.claude/settings.local.json" ] && [ ! -L "$W1DIR/.claude/settings.local.json" ]; then ok
else bad W3-claude-wiring "link=$(ls -l "$W1DIR/.claude" 2>&1 | tr '\n' ';')"; fi

# W3b: `.env` is copied too — it is gitignored for the same reason the toml is, and without it
# every Admin API read from the worktree fails with no_admin_token while the identical ticket
# would have had full store access in the main checkout
if grep -q '^env=copied$' "$O" && [ -f "$W1DIR/.env" ] && [ ! -L "$W1DIR/.env" ] \
   && grep -q '^SHOPIFY_ADMIN_TOKEN=shpat_fixture$' "$W1DIR/.env"; then ok
else bad W3b-env-copied "out=$(grep '^env=' "$O") env=$(cat "$W1DIR/.env" 2>&1 | tr '\n' ';')"; fi

# W3c: the symlink is stamped into the shared `.git/info/exclude`, so git never sees it. The
# documented `.claude/tasks/` line matches directories only — unstamped, the ship run inside the
# worktree would `git add` a link holding an absolute path from one developer's machine.
if ! wt_git -C "$W1DIR" status --porcelain -uall | grep -q '\.claude/tasks' \
   && wt_git -C "$W1DIR" status --porcelain -uall | grep -q '\.claude/settings.local.json' \
   && grep -qx '\.claude/tasks' "$WTR/theme/.git/info/exclude"; then ok
else bad W3c-fnd-link-excluded "status=$(wt_git -C "$W1DIR" status --porcelain -uall | tr '\n' ';')"; fi

# W4: the chosen dev port is recorded in the SHARED workspace (the worktree session finds it
# through the symlink), and it is not the main checkout's 9292
if grep -qE "dev-port: $W1PORT\$" "$WTR/theme/.claude/tasks/ABC-123/notes.md" 2>/dev/null \
   && [ -f "$W1DIR/.claude/tasks/ABC-123/notes.md" ] && [ "$W1PORT" != "9292" ]; then ok
else bad W4-dev-port-recorded "port=$W1PORT notes=$(tr '\n' ';' < "$WTR/theme/.claude/tasks/ABC-123/notes.md" 2>&1)"; fi

# W5 (pin): no package.json in the fixture ⇒ `npm ci` is skipped entirely, not attempted
if grep -q '^npm=skipped$' "$O" && [ ! -s "$WT_NPM_LOG" ]; then ok
else bad W5-npm-skipped "out=$(grep '^npm=' "$O") log=$(tr '\n' ';' < "$WT_NPM_LOG")"; fi

# W6: re-running on an existing worktree is the re-entry path, not an error — same port, and the
# worktree's own shopify.theme.toml is left alone (the preview script writes the new theme id
# into it, so a blind re-copy would throw that away)
printf '# local edit\n' >> "$W1DIR/shopify.theme.toml"
printf 'EXTRA=1\n' >> "$W1DIR/.env"
rc=0; wt_run ABC-123 || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^reused=true$' "$O" && grep -q '^toml=kept$' "$O" \
   && grep -q '^env=kept$' "$O" && grep -q '^EXTRA=1$' "$W1DIR/.env" \
   && [ "$(wt_key dev_port)" = "$W1PORT" ] && grep -q '# local edit' "$W1DIR/shopify.theme.toml" \
   && [ "$(grep -c 'dev-port:' "$WTR/theme/.claude/tasks/ABC-123/notes.md")" -eq 1 ]; then ok
else bad W6-idempotent-rerun "rc=$rc out=$(tr '\n' ';' < "$O")"; fi

# W7: a kebab-case slug is a valid work-id too — not every worktree is ticket-shaped
rc=0; wt_run header-refactor || rc=$?
if [ "$rc" -eq 0 ] && [ -d "$WTR/theme-header-refactor" ] \
   && [ "$(wt_branch "$WTR/theme-header-refactor")" = "feat/header-refactor" ] \
   && [ -d "$WTR/theme/.claude/tasks/header-refactor" ] \
   && ! grep -q '/fnd:ship' "$O"; then ok
else bad W7-slug-create "rc=$rc out=$(tr '\n' ';' < "$O") err=$(head -c 200 "$E" | tr '\n' ' ')"; fi

# W8: anything that is neither a ticket key nor a clean slug is refused BEFORE any git write —
# the work-id becomes a branch name, a directory name and a workspace name
for badid in Bad_ID ABC-12a abc--x trail- "sp ace" ../escape; do
  rc=0; wt_run "$badid" || rc=$?
  if [ "$rc" -eq 1 ] && grep -q '^error=invalid_work_id' "$O" \
     && [ ! -e "$WTR/theme-$badid" ]; then ok
  else bad "W8-invalid-id[$badid]" "rc=$rc out=$(head -c 160 "$O" | tr '\n' ' ')"; fi
done

# W8b: a leading dash is a flag as far as any shell parser is concerned — it must be refused
# there, before it can be mistaken for a positional work-id
rc=0; wt_run -lead || rc=$?
if [ "$rc" -eq 1 ] && grep -q '^error=unknown arg: -lead' "$O"; then ok
else bad W8b-dash-id "rc=$rc out=$(head -c 160 "$O" | tr '\n' ' ')"; fi

# W9: an existing LOCAL feat/<KEY> is checked out into the worktree, never duplicated
wt_git -C "$WTR/theme" branch -q feat/REU-7 develop
rc=0; wt_run REU-7 || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^branch_source=local$' "$O" \
   && [ "$(wt_branch "$WTR/theme-REU-7")" = "feat/REU-7" ] \
   && [ "$(wt_git -C "$WTR/theme" branch --list 'feat/REU-7' | wc -l | tr -d ' ')" = "1" ]; then ok
else bad W9-local-branch-reuse "rc=$rc out=$(tr '\n' ';' < "$O")"; fi

# W9b: a branch that exists only on origin is fetched and tracked, not forked off the base
wt_git -C "$WTR/theme" branch -q feat/REM-8 develop
wt_git -C "$WTR/theme" push -q origin feat/REM-8
wt_git -C "$WTR/theme" branch -qD feat/REM-8
wt_git -C "$WTR/theme" update-ref -d refs/remotes/origin/feat/REM-8
rc=0; wt_run REM-8 || rc=$?
wt_up="$(wt_git -C "$WTR/theme-REM-8" rev-parse --abbrev-ref '@{upstream}' 2>/dev/null || true)"
if [ "$rc" -eq 0 ] && grep -q '^branch_source=remote$' "$O" \
   && [ "$(wt_branch "$WTR/theme-REM-8")" = "feat/REM-8" ] \
   && [ "$wt_up" = "origin/feat/REM-8" ]; then ok
else bad W9b-remote-branch-reuse "rc=$rc upstream=$wt_up out=$(tr '\n' ';' < "$O")"; fi

# W9c: with origin unreachable (offline, VPN down, dead credential helper) the live `ls-remote`
# is the only check that fails — the remote-tracking ref is still on disk, and treating its
# branch as new would fork a fresh feat/<KEY> off the base and orphan the pushed commits
wt_git -C "$WTR/theme" checkout -q -b feat/OFF-3
printf 'colleague work\n' > "$WTR/theme/work.txt"
wt_git -C "$WTR/theme" add work.txt
wt_git -C "$WTR/theme" commit -qm colleague
wt_git -C "$WTR/theme" push -q origin feat/OFF-3
wt_git -C "$WTR/theme" checkout -q develop
wt_git -C "$WTR/theme" branch -qD feat/OFF-3
wt_git -C "$WTR/theme" fetch -q origin '+refs/heads/feat/OFF-3:refs/remotes/origin/feat/OFF-3'
wt_git -C "$WTR/theme" remote set-url origin "$WTR/unreachable.git"
rc=0; wt_run OFF-3 || rc=$?
wt_git -C "$WTR/theme" remote set-url origin "$WTR/origin.git"
if [ "$rc" -eq 0 ] && grep -q '^branch_source=remote$' "$O" \
   && [ -f "$WTR/theme-OFF-3/work.txt" ]; then ok
else bad W9c-offline-remote-ref "rc=$rc out=$(tr '\n' ';' < "$O")"; fi

# W10: no store config in the repo is a WARNING — the worktree is still usable for code work
mv "$WTR/theme/shopify.theme.toml" "$WTR/toml.bak"
rc=0; wt_run NOT-1 || rc=$?
mv "$WTR/toml.bak" "$WTR/theme/shopify.theme.toml"
if [ "$rc" -eq 0 ] && grep -q '^warn=no_shopify_theme_toml' "$O" && grep -q '^toml=missing$' "$O" \
   && [ -d "$WTR/theme-NOT-1" ]; then ok
else bad W10-missing-toml-warns "rc=$rc out=$(tr '\n' ';' < "$O")"; fi

# W11: the port probe steps over a port that is already listening. The occupied port is the one
# the scan would otherwise hand out next — an already-recorded port (9293 by now) would be
# skipped by the recorded-port bookkeeping alone and the live probe would go untested.
wt_probe_port="$(wt_next_port)"
wt_listen "$wt_probe_port"
rc=0; wt_run PORT-2 || rc=$?
wt_port2="$(wt_key dev_port)"
wt_unlisten
if [ "$rc" -eq 0 ] && [ -n "$wt_port2" ] && [ "$wt_port2" != "$wt_probe_port" ] \
   && [ "$wt_port2" -gt "$wt_probe_port" ]; then ok
else bad W11-port-probe "rc=$rc port=$wt_port2 occupied=$wt_probe_port out=$(tr '\n' ';' < "$O")"; fi

# W11b (bug): "nothing is listening" is not enough. The dev servers are started later, by hand,
# in the new sessions — so at setup time NOTHING listens and two worktrees created a minute
# apart were both handed 9293, which is exactly the parallel case the feature exists for.
rc=0; wt_run PAR-3 || rc=$?; wt_par1="$(wt_key dev_port)"
rc2=0; wt_run PAR-4 || rc2=$?; wt_par2="$(wt_key dev_port)"
if [ "$rc" -eq 0 ] && [ "$rc2" -eq 0 ] && [ -n "$wt_par1" ] && [ -n "$wt_par2" ] \
   && [ "$wt_par1" != "$wt_par2" ]; then ok
else bad W11b-port-per-worktree "rc=$rc/$rc2 ports=$wt_par1/$wt_par2 out=$(tr '\n' ';' < "$O")"; fi

# W12: --remove refuses a worktree with real uncommitted work and removes nothing
printf 'edited in the worktree\n' >> "$W1DIR/README.md"
rc=0; wt_run --remove ABC-123 || rc=$?
if [ "$rc" -eq 1 ] && grep -q '^error=worktree_dirty' "$O" && grep -q '^dirty=.*README.md' "$O" \
   && [ -d "$W1DIR" ]; then ok
else bad W12-remove-dirty-refused "rc=$rc out=$(tr '\n' ';' < "$O")"; fi

# W13: --force is the override, and it takes the worktree with it
rc=0; wt_run --remove ABC-123 --force || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^removed=' "$O" && [ ! -d "$W1DIR" ] \
   && grep -q '^branch_kept=true$' "$O" \
   && wt_git -C "$WTR/theme" show-ref --verify --quiet refs/heads/feat/ABC-123; then ok
else bad W13-remove-force "rc=$rc out=$(tr '\n' ';' < "$O") dir=$([ -d "$W1DIR" ] && echo present)"; fi

# W14 (the data-loss guard): a CLEAN worktree removes without --force even though the `.claude`
# wiring and the copied toml are untracked (git's own `worktree remove` refuses on those), and
# the shared task workspace in the MAIN checkout survives — the symlink is dropped before the
# removal, so nothing follows it back into `<main>/.claude/tasks`.
printf 'the approved plan\n' > "$WTR/theme/.claude/tasks/header-refactor/plan.md"
rc=0; wt_run --remove header-refactor || rc=$?
if [ "$rc" -eq 0 ] && [ ! -d "$WTR/theme-header-refactor" ] \
   && [ -d "$WTR/theme/.claude/tasks/header-refactor" ] \
   && [ "$(cat "$WTR/theme/.claude/tasks/header-refactor/plan.md" 2>/dev/null)" = "the approved plan" ] \
   && [ -f "$WTR/theme/.claude/tasks/ABC-123/notes.md" ] \
   && grep -q "^workspace_kept=$WTMAIN/.claude/tasks/header-refactor$" "$O"; then ok
else bad W14-remove-clean-keeps-workspace "rc=$rc out=$(tr '\n' ';' < "$O") left=$(ls "$WTR/theme/.claude/tasks" 2>&1 | tr '\n' ' ')"; fi

# W14b: the workspace outlives the worktree by design, so its `dev-port:` line is still there on
# a re-create — sticky is right for a re-entry (the dev server is already on that port) but a
# fresh worktree must re-probe rather than hand back a number something else took meanwhile
wt_listen "$W1PORT"
rc=0; wt_run ABC-123 || rc=$?
wt_port3="$(wt_key dev_port)"
wt_unlisten
if [ "$rc" -eq 0 ] && grep -q '^reused=false$' "$O" && [ -n "$wt_port3" ] \
   && [ "$wt_port3" != "$W1PORT" ]; then ok
else bad W14b-stale-port-reprobed "rc=$rc port=$wt_port3 was=$W1PORT out=$(tr '\n' ';' < "$O")"; fi

# W15: removing something that is not a registered worktree is a named refusal, not a `rm -rf`
rc=0; wt_run --remove NOPE-9 || rc=$?
if [ "$rc" -eq 1 ] && grep -q '^error=worktree_not_found' "$O"; then ok
else bad W15-remove-unknown "rc=$rc out=$(head -c 160 "$O" | tr '\n' ' ')"; fi

# W16: a directory already sitting at the worktree path is a hard stop — git does not know it,
# and `worktree add` would fail late with the developer's files half-consumed
mkdir -p "$WTR/theme-TAKEN-1"; printf 'mine\n' > "$WTR/theme-TAKEN-1/keep.txt"
rc=0; wt_run TAKEN-1 || rc=$?
if [ "$rc" -eq 1 ] && grep -q '^error=worktree_path_taken' "$O" \
   && [ -f "$WTR/theme-TAKEN-1/keep.txt" ]; then ok
else bad W16-path-taken "rc=$rc out=$(head -c 160 "$O" | tr '\n' ' ')"; fi

# W17: outside a git repo the script says so instead of resolving a worktree path from $0 — it
# ships inside the installed plugin, far from any client repo, so the leak to rule out is a
# worktree hanging off THIS repo (the only checkout $0 could reach) or off the fixture root
rc=0; (cd "$WTR" && HOME="$WTR/home" GIT_CONFIG_NOSYSTEM=1 GIT_CEILING_DIRECTORIES="$WTR" \
  "$BASH_BIN" "$WTS" OUT-1) >"$O" 2>"$E" || rc=$?
wt_leak="$(ls -d "$WTR"/*OUT-1 "$(dirname "$ROOT")"/*OUT-1 2>/dev/null | tr '\n' ' ')"
wt_plug_leak="$(git -C "$ROOT" worktree list --porcelain 2>/dev/null | grep -c 'OUT-1' || true)"
if [ "$rc" -eq 1 ] && grep -q '^error=not_a_git_repo' "$O" \
   && [ -z "$wt_leak" ] && [ "$wt_plug_leak" -eq 0 ]; then ok
else bad W17-outside-repo "rc=$rc leak='$wt_leak' plug=$wt_plug_leak out=$(head -c 160 "$O" | tr '\n' ' ')"; fi

# W18: a bare invocation prints the usage line instead of dying under `set -u`
rc=0; wt_run || rc=$?
if [ "$rc" -eq 1 ] && grep -q '^error=usage: worktree-setup.sh' "$O"; then ok
else bad W18-usage "rc=$rc out=$(head -c 160 "$O" | tr '\n' ' ') err=$(head -c 160 "$E" | tr '\n' ' ')"; fi

# W19 (bug): the hand-off line is pasted into a shell verbatim. Unquoted, a repo under a path
# with a space makes `cd` a three-argument call — it errors, `claude` then starts in whatever
# directory the developer was in (the main checkout), which is what the feature exists to
# prevent. Asserted by actually running the printed line and checking where it lands.
mkdir -p "$WTR/sp ace"
wt_git init --bare -q "$WTR/sp ace/origin.git"
wt_git init -q "$WTR/sp ace/theme"
printf 'x\n' > "$WTR/sp ace/theme/README.md"
wt_git -C "$WTR/sp ace/theme" add -A
wt_git -C "$WTR/sp ace/theme" commit -qm init
wt_git -C "$WTR/sp ace/theme" remote add origin "$WTR/sp ace/origin.git"
wt_git -C "$WTR/sp ace/theme" push -qu origin develop
rc=0; (cd "$WTR/sp ace/theme" && HOME="$WTR/home" GIT_CONFIG_NOSYSTEM=1 PATH="$WTR/shim:$PATH" \
  "$BASH_BIN" "$WTS" SPC-1) >"$O" 2>"$E" || rc=$?
wt_spdir="$(cd "$WTR/sp ace/theme-SPC-1" 2>/dev/null && pwd -P || true)"
wt_cdline="$(grep '^  cd .* && claude$' "$O" | head -1 | sed 's/^  //; s/ && claude$//')"
wt_land="$( (eval "$wt_cdline" >/dev/null 2>&1; pwd -P) 2>/dev/null || true )"
if [ "$rc" -eq 0 ] && [ -n "$wt_spdir" ] && [ "$wt_land" = "$wt_spdir" ]; then ok
else bad W19-handoff-quoted "rc=$rc land=$wt_land want=$wt_spdir line=$wt_cdline"; fi

# W20: the report names the branch the worktree is REALLY on. A developer who switched branches
# inside it must not be told the run continues on feat/<WORK-ID>, nor — on removal — that
# feat/<WORK-ID> was "kept" while the branch actually holding the work goes unmentioned.
rc=0; wt_run DIF-5 || rc=$?
wt_git -C "$WTR/theme-DIF-5" checkout -q -b hotfix/other
rc=0; wt_run DIF-5 || rc=$?
wt_dif_create="$(wt_key branch)"
wt_dif_warn=0; grep -q '^warn=branch_switched expected=feat/DIF-5 actual=hotfix/other' "$O" && wt_dif_warn=1
rc2=0; wt_run --remove DIF-5 --force || rc2=$?
if [ "$rc" -eq 0 ] && [ "$rc2" -eq 0 ] && [ "$wt_dif_create" = "hotfix/other" ] \
   && [ "$wt_dif_warn" -eq 1 ] && [ "$(wt_key branch)" = "hotfix/other" ]; then ok
else bad W20-actual-branch-reported "rc=$rc/$rc2 create=$wt_dif_create warn=$wt_dif_warn remove=$(wt_key branch)"; fi

# W21 (bug): the dirty check has to see INSIDE `.claude/`. Without `-uall` git collapses an
# untracked directory to one `?? .claude/` line, which the skip list swallowed whole — so
# --remove deleted a developer's QA notes without ever listing them on a `dirty=` line.
rc=0; wt_run QAN-1 || rc=$?
mkdir -p "$WTR/theme-QAN-1/.claude/notes"
printf 'qa checklist\n' > "$WTR/theme-QAN-1/.claude/notes/qa.md"
rc2=0; wt_run --remove QAN-1 || rc2=$?
if [ "$rc" -eq 0 ] && [ "$rc2" -eq 1 ] && grep -q '^error=worktree_dirty' "$O" \
   && grep -q '^dirty=.*\.claude/notes/qa\.md' "$O" \
   && [ -f "$WTR/theme-QAN-1/.claude/notes/qa.md" ]; then ok
else bad W21-dirty-sees-into-claude "rc=$rc/$rc2 out=$(tr '\n' ';' < "$O")"; fi
wt_run --remove QAN-1 --force >/dev/null 2>&1 || true

# W22 (data loss): a detached HEAD is held by nothing but the worktree's own HEAD/reflog, both
# of which `git worktree remove` deletes — a mid-rebase commit made there becomes unreachable.
# The removal must refuse, and under --force must print the sha instead of claiming a branch.
rc=0; wt_run DET-6 || rc=$?
wt_git -C "$WTR/theme-DET-6" checkout -q --detach
printf 'mid-rebase work\n' > "$WTR/theme-DET-6/detached.txt"
wt_git -C "$WTR/theme-DET-6" add detached.txt
wt_git -C "$WTR/theme-DET-6" commit -qm 'only this HEAD holds it'
wt_det_sha="$(wt_git -C "$WTR/theme-DET-6" rev-parse HEAD)"
rc2=0; wt_run --remove DET-6 || rc2=$?
wt_det_refused=0
if grep -q '^error=worktree_detached' "$O" && grep -qF "$wt_det_sha" "$O" \
   && [ -d "$WTR/theme-DET-6" ]; then wt_det_refused=1; fi
rc3=0; wt_run --remove DET-6 --force || rc3=$?
if [ "$rc" -eq 0 ] && [ "$rc2" -eq 1 ] && [ "$wt_det_refused" -eq 1 ] && [ "$rc3" -eq 0 ] \
   && [ ! -d "$WTR/theme-DET-6" ] && grep -qF "warn=detached_head_removed head=$wt_det_sha" "$O" \
   && ! grep -q '^branch_kept=true$' "$O"; then ok
else bad W22-remove-detached "rc=$rc/$rc2/$rc3 refused=$wt_det_refused sha=$wt_det_sha out=$(tr '\n' ';' < "$O")"; fi

# W23 (bug): the workspace outlives the worktree by design, so the port it recorded has to be
# RELEASED when the worktree goes — held forever, every finished ticket burned one of the 20.
rc=0; wt_run REL-9 || rc=$?; wt_rel1="$(wt_key dev_port)"
rc2=0; wt_run --remove REL-9 || rc2=$?
rc3=0; wt_run REL-10 || rc3=$?; wt_rel2="$(wt_key dev_port)"
if [ "$rc" -eq 0 ] && [ "$rc2" -eq 0 ] && [ "$rc3" -eq 0 ] \
   && [ -f "$WTR/theme/.claude/tasks/REL-9/notes.md" ] && [ -n "$wt_rel1" ] \
   && [ "$wt_rel2" = "$wt_rel1" ]; then ok
else bad W23-port-released-on-remove "rc=$rc/$rc2/$rc3 ports=$wt_rel1/$wt_rel2 out=$(tr '\n' ';' < "$O")"; fi
wt_run --remove REL-10 --force >/dev/null 2>&1 || true

# W24 (bug): twenty work-ids whose worktrees are long gone used to exhaust the range for good —
# and the refusal fired at the END, after `worktree add`, leaving a registered worktree behind
# that made the re-run fail with worktree_path_taken. Nothing is listening on any of them.
i=9293
while [ "$i" -le 9312 ]; do
  mkdir -p "$WTR/theme/.claude/tasks/OLD-$i"
  printf -- '- 2026-01-01 worktree `gone` on branch `feat/OLD-%s`, dev-port: %s\n' "$i" "$i" \
    > "$WTR/theme/.claude/tasks/OLD-$i/notes.md"
  i=$((i + 1))
done
rc=0; wt_run EXH-1 || rc=$?
wt_exh_port="$(wt_key dev_port)"
rm -rf "$WTR"/theme/.claude/tasks/OLD-*
if [ "$rc" -eq 0 ] && [ -d "$WTR/theme-EXH-1" ] && ! grep -q '^error=' "$O" \
   && printf '%s' "$wt_exh_port" | grep -qE '^9[0-9]+$'; then ok
else bad W24-stale-ports-released "rc=$rc port=$wt_exh_port out=$(tr '\n' ';' < "$O")"; fi
wt_run --remove EXH-1 --force >/dev/null 2>&1 || true

# W25 (bug): the exclude stamp appends to a file the DEVELOPER owns. One whose last byte is not
# a newline — hand-edited ones often are — used to get `.claude/tasks` glued onto the last
# pattern, which breaks that pattern and leaves the symlink unexcluded. Fresh repo: the main
# fixture's exclude was already stamped (and already ends in a newline).
mkdir -p "$WTR/nonl"
wt_git init --bare -q "$WTR/nonl/origin.git"
wt_git init -q "$WTR/nonl/theme"
printf 'x\n' > "$WTR/nonl/theme/README.md"
wt_git -C "$WTR/nonl/theme" add -A
wt_git -C "$WTR/nonl/theme" commit -qm init
wt_git -C "$WTR/nonl/theme" remote add origin "$WTR/nonl/origin.git"
wt_git -C "$WTR/nonl/theme" push -qu origin develop
printf 'secret.txt' > "$WTR/nonl/theme/.git/info/exclude"
rc=0; (cd "$WTR/nonl/theme" && HOME="$WTR/home" GIT_CONFIG_NOSYSTEM=1 PATH="$WTR/shim:$PATH" \
  "$BASH_BIN" "$WTS" NL-1) >"$O" 2>"$E" || rc=$?
WT_NL_EXCL="$WTR/nonl/theme/.git/info/exclude"
if [ "$rc" -eq 0 ] && grep -qx 'secret.txt' "$WT_NL_EXCL" && grep -qx '\.claude/tasks' "$WT_NL_EXCL" \
   && ! grep -q 'secret.txt\.claude' "$WT_NL_EXCL"; then ok
else bad W25-exclude-trailing-newline "rc=$rc exclude=$(tr '\n' ';' < "$WT_NL_EXCL" 2>&1)"; fi

# W26: with no /dev/tcp and no usable `nc` there is no way to ask whether a port is free — the
# run must still hand one out and SAY it was unchecked, naming the dev server's own --port (the
# script has no --port flag of its own). A bash built without net redirections cannot be
# conjured here, so the copy under test has the probe's verdict line replaced by the message
# such a bash prints, and a shim `nc` rejects -z the way ncat builds do.
WTS_NP="$WTR/worktree-setup-noprobe.sh"
sed 's#^DEVTCP_MSG=.*#DEVTCP_MSG="fnd-sim: No such file or directory"#' "$WTS" > "$WTS_NP"
mkdir -p "$WTR/ncshim"
cat > "$WTR/ncshim/nc" <<'FAKE'
#!/usr/bin/env bash
printf 'usage: nc [-46CDdFhklNnrStUuvZz]\n' >&2
exit 1
FAKE
chmod +x "$WTR/ncshim/nc"
rc=0; (cd "$WTR/theme" && HOME="$WTR/home" GIT_CONFIG_NOSYSTEM=1 PATH="$WTR/ncshim:$WTR/shim:$PATH" \
  "$BASH_BIN" "$WTS_NP" NOP-1) >"$O" 2>"$E" || rc=$?
wt_nop_port="$(wt_key dev_port)"
if [ "$rc" -eq 0 ] && grep -q '^DEVTCP_MSG="fnd-sim' "$WTS_NP" \
   && [ "$(grep -c '^warn=port_probe_unavailable' "$O")" -eq 1 ] \
   && grep -qF 'shopify theme dev --port' "$O" \
   && printf '%s' "$wt_nop_port" | grep -qE '^9[0-9]+$' && [ -d "$WTR/theme-NOP-1" ]; then ok
else bad W26-port-probe-unavailable "rc=$rc port=$wt_nop_port out=$(tr '\n' ';' < "$O")"; fi
wt_run --remove NOP-1 --force >/dev/null 2>&1 || true

# W27: in a submodule (or a `--separate-git-dir` checkout) the common git dir is not inside the
# working tree, so dirname(common dir) is not a checkout — the sibling worktree and the shared
# `.claude/tasks` would be created inside git's own plumbing. Named refusal, nothing created.
mkdir -p "$WTR/sep"
wt_git init -q --separate-git-dir "$WTR/sep/realgit" "$WTR/sep/theme"
rc=0; (cd "$WTR/sep/theme" && HOME="$WTR/home" GIT_CONFIG_NOSYSTEM=1 PATH="$WTR/shim:$PATH" \
  "$BASH_BIN" "$WTS" SEP-1) >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 1 ] && grep -q '^error=unsupported_layout' "$O" \
   && [ ! -e "$WTR/sep-SEP-1" ] && [ ! -e "$WTR/sep/realgit/.claude" ]; then ok
else bad W27-separate-git-dir "rc=$rc out=$(head -c 200 "$O" | tr '\n' ' ')"; fi

# W28 (bug): the main checkout's shopify.theme.toml is routinely a PINNED session config by the
# time a second work stream starts (ship pins it whenever the developer stays in the main
# checkout). Copying that verbatim hands the new worktree another stream's session theme as its
# dev theme — which is where its first `create --reuse --pin-toml` would pull customizer settings
# from, so ticket A's half-edited preview lands on ticket B's theme. The copy is un-pinned instead:
# the superseded line is restored and the session id is commented out, value intact.
printf '[environments.development]\nstore = "acme-dev"\n# theme = "111"  # fnd:superseded\ntheme = "777"\n' > "$WTR/theme/shopify.theme.toml"
rc=0; wt_run PIN-1 || rc=$?
W28DIR="$WTR/theme-PIN-1"; W28T="$W28DIR/shopify.theme.toml"
WANT28='[environments.development]
store = "acme-dev"
theme = "111"
# theme = "777"'
if [ "$rc" -eq 0 ] && grep -q '^toml=copied$' "$O" && grep -q '^toml_unpinned=yes$' "$O" \
   && [ "$(cat "$W28T")" = "$WANT28" ] \
   && grep -qx '# theme = "111"  # fnd:superseded' "$WTR/theme/shopify.theme.toml"; then ok
else bad W28-worktree-unpins-copy "rc=$rc out=$(grep -E '^toml' "$O" | tr '\n' ';') copy=$(tr '\n' ';' < "$W28T" 2>&1)"; fi

# W28b: an UNPINNED main config (no marker) is copied byte-for-byte — the un-pin must never be a
# rewrite of a file it did not recognise
printf '[environments.development]\nstore = "acme-dev"\ntheme = "111"\n' > "$WTR/theme/shopify.theme.toml"
rc=0; wt_run PIN-2 || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^toml_unpinned=no$' "$O" \
   && cmp -s "$WTR/theme/shopify.theme.toml" "$WTR/theme-PIN-2/shopify.theme.toml"; then ok
else bad W28b-worktree-copy-untouched "rc=$rc out=$(grep -E '^toml' "$O" | tr '\n' ';')"; fi

# W28c (bug): a multi-environment source toml can carry ONE PIN PER BLOCK (each block pinned by
# its own stream) — the un-pin used to stop at the first marker it restored, silently handing the
# new worktree the second block's session theme. Every marker pair is reverted, block-agnostic.
printf '[environments.dev]\nstore = "acme-dev"\n# theme = "111"  # fnd:superseded\ntheme = "777"\n\n[environments.staging]\nstore = "acme-dev"\n# theme = "222"  # fnd:superseded\ntheme = "888"\n' > "$WTR/theme/shopify.theme.toml"
rc=0; wt_run PIN-3 || rc=$?
W28CT="$WTR/theme-PIN-3/shopify.theme.toml"
WANT28C='[environments.dev]
store = "acme-dev"
theme = "111"
# theme = "777"

[environments.staging]
store = "acme-dev"
theme = "222"
# theme = "888"'
if [ "$rc" -eq 0 ] && grep -q '^toml_unpinned=yes$' "$O" \
   && [ "$(cat "$W28CT")" = "$WANT28C" ]; then ok
else bad W28c-unpin-every-block "rc=$rc out=$(grep -E '^toml' "$O" | tr '\n' ';') copy=$(grep -v password "$W28CT" 2>/dev/null | tr '\n' ';')"; fi

# W28d (bug): a Windows-edited (CRLF) source toml round-trips through the un-pin with its line
# endings intact — a restore that dropped the CR on the touched lines only would leave the copy
# mixed-ending, a diff the developer cannot explain
printf '[environments.development]\r\nstore = "acme-dev"\r\n# theme = "111"  # fnd:superseded\r\ntheme = "777"\r\n' > "$WTR/theme/shopify.theme.toml"
rc=0; wt_run PIN-4 || rc=$?
W28DT="$WTR/theme-PIN-4/shopify.theme.toml"
printf '[environments.development]\r\nstore = "acme-dev"\r\ntheme = "111"\r\n# theme = "777"\r\n' > "$WTR/w28d.want"
if [ "$rc" -eq 0 ] && grep -q '^toml_unpinned=yes$' "$O" && cmp -s "$W28DT" "$WTR/w28d.want"; then ok
else bad W28d-unpin-crlf "rc=$rc out=$(grep -E '^toml' "$O" | tr '\n' ';') copy=$(od -c "$W28DT" 2>&1 | head -4 | tr '\n' ';')"; fi

# W28e (blocker): the APPEND round trip — a source toml whose block had no `theme =` line was
# pinned (the line create-preview-theme.sh appended carries `# fnd:session-theme`), and the
# worktree copy must come out BYTE-IDENTICAL to the pre-pin original: the tag names the one line
# the un-pin may delete, because there is no superseded line to restore. The pin is the real one,
# not a hand-written fixture.
printf '[environments.development]\nstore = "acme-dev"\npassword = "shptka_fixture1234"\n' > "$WTR/theme/shopify.theme.toml"
cp "$WTR/theme/shopify.theme.toml" "$WTR/w28e.orig"
rc=0; L="$TMP/cptw28e"; : > "$L"
run_cpt "$L" TOML_PATH="$WTR/theme/shopify.theme.toml" FAKE_LIST="$PIN_LIST" -- pin --theme 222 || rc=$?
TAGGED28E=no; grep -q 'fnd:session-theme' "$WTR/theme/shopify.theme.toml" && TAGGED28E=yes
rc2=0; wt_run PIN-5 || rc2=$?
W28ET="$WTR/theme-PIN-5/shopify.theme.toml"
if [ "$rc" -eq 0 ] && [ "$TAGGED28E" = "yes" ] && [ "$rc2" -eq 0 ] \
   && grep -q '^toml_unpinned=yes$' "$O" && cmp -s "$W28ET" "$WTR/w28e.orig" \
   && grep -q 'fnd:session-theme' "$WTR/theme/shopify.theme.toml"; then ok
else bad W28e-append-roundtrip "rc=$rc rc2=$rc2 tagged=$TAGGED28E out=$(grep -E '^toml' "$O" | tr '\n' ';') copy=$(grep -v password "$W28ET" 2>/dev/null | tr '\n' ';')"; fi

# W28f (bug): a stray comment mentioning fnd:superseded is NOT a marker — the un-pin must leave
# it alone and still find the real marker pair below it (the pin side of this is P49)
printf '[environments.development]\nstore = "acme-dev"\n# NB fnd:superseded markers are plugin-managed\n# theme = "111"  # fnd:superseded\ntheme = "777"\n' > "$WTR/theme/shopify.theme.toml"
rc=0; wt_run PIN-6 || rc=$?
W28FT="$WTR/theme-PIN-6/shopify.theme.toml"
WANT28F='[environments.development]
store = "acme-dev"
# NB fnd:superseded markers are plugin-managed
theme = "111"
# theme = "777"'
if [ "$rc" -eq 0 ] && grep -q '^toml_unpinned=yes$' "$O" \
   && [ "$(cat "$W28FT")" = "$WANT28F" ]; then ok
else bad W28f-unpin-stray-comment "rc=$rc out=$(grep -E '^toml' "$O" | tr '\n' ';') copy=$(grep -v password "$W28FT" 2>/dev/null | tr '\n' ';')"; fi

# W29 (bug): the hand-off block the skill relays VERBATIM must not advertise a dev-server command
# without `--theme` — that is the one that syncs the branch into the shared dev theme
if grep -q 'npm run dev -- --theme <session-theme-id> --port' "$O" \
   && ! grep -q '(dev server: --port' "$O"; then ok
else bad W29-handoff-names-theme "out=$(grep -n 'dev server' "$O" | tr '\n' ';')"; fi

# W30 (rename migration): a main checkout still holding the legacy `.claude/fnd` workspace —
# the run moves it to `.claude/tasks` once (never merging into an existing new home), so
# per-ticket memory follows the rename before the shared symlink is created.
mkdir -p "$WTR/mig"
wt_git init --bare -q "$WTR/mig/origin.git"
wt_git init -q "$WTR/mig/theme"
printf 'x\n' > "$WTR/mig/theme/README.md"
wt_git -C "$WTR/mig/theme" add -A
wt_git -C "$WTR/mig/theme" commit -qm init
wt_git -C "$WTR/mig/theme" remote add origin "$WTR/mig/origin.git"
wt_git -C "$WTR/mig/theme" push -qu origin develop
mkdir -p "$WTR/mig/theme/.claude/fnd/MIG-1"
printf '# MIG-1 — notes\nlegacy note\n' > "$WTR/mig/theme/.claude/fnd/MIG-1/notes.md"
rc=0; (cd "$WTR/mig/theme" && HOME="$WTR/home" GIT_CONFIG_NOSYSTEM=1 PATH="$WTR/shim:$PATH" \
  "$BASH_BIN" "$WTS" MIG-1) >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ ! -e "$WTR/mig/theme/.claude/fnd" ] \
   && grep -qx 'legacy note' "$WTR/mig/theme/.claude/tasks/MIG-1/notes.md" 2>/dev/null \
   && [ -L "$WTR/mig/theme-MIG-1/.claude/tasks" ]; then ok
else bad W30-legacy-workspace-migrated "rc=$rc fnd=$(ls "$WTR/mig/theme/.claude" 2>&1 | tr '\n' ' ') out=$(tr '\n' ';' < "$O")"; fi

# A fresh theme fixture per migration case: the rename runs once per checkout, so each case
# needs its own main checkout to run it in.
mk_mig_repo() { # <dir>
  mkdir -p "$1"
  wt_git init --bare -q "$1/origin.git"
  wt_git init -q "$1/theme"
  printf 'x\n' > "$1/theme/README.md"
  wt_git -C "$1/theme" add -A
  wt_git -C "$1/theme" commit -qm init
  wt_git -C "$1/theme" remote add origin "$1/origin.git"
  wt_git -C "$1/theme" push -qu origin develop
}
mig_run() { # <repo-dir> <args…>
  (cd "$1/theme" && HOME="$WTR/home" GIT_CONFIG_NOSYSTEM=1 PATH="$WTR/shim:$PATH" \
     "$BASH_BIN" "$WTS" "${@:2}") >"$O" 2>"$E"
}

# W30a: BOTH homes present — the new one is real content, and the migration may not merge into
# it or overwrite it. The legacy directory stays where it is, untouched, for the developer.
mk_mig_repo "$WTR/mig2"
mkdir -p "$WTR/mig2/theme/.claude/fnd/OLD-1" "$WTR/mig2/theme/.claude/tasks/NEW-1"
printf 'legacy\n' > "$WTR/mig2/theme/.claude/fnd/OLD-1/notes.md"
printf 'current\n' > "$WTR/mig2/theme/.claude/tasks/NEW-1/notes.md"
rc=0; mig_run "$WTR/mig2" MIG-2 || rc=$?
if [ "$rc" -eq 0 ] && grep -qx 'legacy' "$WTR/mig2/theme/.claude/fnd/OLD-1/notes.md" 2>/dev/null \
   && grep -qx 'current' "$WTR/mig2/theme/.claude/tasks/NEW-1/notes.md" 2>/dev/null \
   && [ ! -e "$WTR/mig2/theme/.claude/tasks/OLD-1" ]; then ok
else bad W30a-no-merge "rc=$rc fnd=$(ls "$WTR/mig2/theme/.claude/fnd" 2>&1 | tr '\n' ' ') tasks=$(ls "$WTR/mig2/theme/.claude/tasks" 2>&1 | tr '\n' ' ')"; fi

# W30b: a `.claude/fnd` that is already a SYMLINK is somebody's own wiring (or a worktree's link
# into another checkout) — `mv` would move the link, not the workspace behind it.
mk_mig_repo "$WTR/mig3"
mkdir -p "$WTR/mig3/theme/.claude" "$WTR/mig3/elsewhere/MIG-3"
printf 'elsewhere\n' > "$WTR/mig3/elsewhere/MIG-3/notes.md"
ln -s "$WTR/mig3/elsewhere" "$WTR/mig3/theme/.claude/fnd"
rc=0; mig_run "$WTR/mig3" MIG-3 || rc=$?
if [ "$rc" -eq 0 ] && [ -L "$WTR/mig3/theme/.claude/fnd" ] \
   && [ "$(readlink "$WTR/mig3/theme/.claude/fnd")" = "$WTR/mig3/elsewhere" ]; then ok
else bad W30b-symlink-untouched "rc=$rc link=$(readlink "$WTR/mig3/theme/.claude/fnd" 2>&1)"; fi

# W30c (bug): the migration runs in BOTH modes, but the exclude stamp used to run only in create
# mode — a `--remove` that renamed the workspace left it untracked AND unignored, one bulk
# `git add` away from a client PR. The teardown below is the only run that touches this checkout.
mk_mig_repo "$WTR/mig4"
rc=0; mig_run "$WTR/mig4" MIG-4 || rc=$?         # create the worktree first…
# …then put the checkout back into its pre-rename shape (the state a worktree made by the older
# script is torn down from) and drop the stamp the create run left behind
mv "$WTR/mig4/theme/.claude/tasks" "$WTR/mig4/theme/.claude/fnd"
mkdir -p "$WTR/mig4/theme/.claude/fnd/OLD-4"
printf 'legacy\n' > "$WTR/mig4/theme/.claude/fnd/OLD-4/notes.md"
rm -f "$WTR/mig4/theme/.git/info/exclude"
rc2=0; mig_run "$WTR/mig4" --remove MIG-4 --force || rc2=$?
if [ "$rc" -eq 0 ] && [ "$rc2" -eq 0 ] \
   && grep -qx 'legacy' "$WTR/mig4/theme/.claude/tasks/OLD-4/notes.md" 2>/dev/null \
   && grep -qx '\.claude/tasks' "$WTR/mig4/theme/.git/info/exclude" 2>/dev/null; then ok
else bad W30c-remove-mode-exclude "rc=$rc rc2=$rc2 out=$(tr '\n' ';' < "$O") exclude=$(tr '\n' ';' < "$WTR/mig4/theme/.git/info/exclude" 2>&1)"; fi

# W30d (bug): worktrees created BEFORE the rename hold `<wt>/.claude/fnd -> <main>/.claude/fnd`.
# The `mv` leaves every one of them dangling, so the session working there quietly starts its own
# private workspace and the two forks of the task memory never meet again. Each link is re-pointed
# under the new name instead, and the legacy one dropped only once its replacement exists.
mk_mig_repo "$WTR/mig5"
mkdir -p "$WTR/mig5/theme/.claude/fnd/OLD-5"
printf 'legacy\n' > "$WTR/mig5/theme/.claude/fnd/OLD-5/notes.md"
wt_git -C "$WTR/mig5/theme" worktree add -q -b feat/pre-rename "$WTR/mig5/theme-pre" >/dev/null 2>&1
mkdir -p "$WTR/mig5/theme-pre/.claude"
ln -s "$WTR/mig5/theme/.claude/fnd" "$WTR/mig5/theme-pre/.claude/fnd"
rc=0; mig_run "$WTR/mig5" MIG-5 || rc=$?
if [ "$rc" -eq 0 ] && [ -L "$WTR/mig5/theme-pre/.claude/tasks" ] \
   && [ ! -e "$WTR/mig5/theme-pre/.claude/fnd" ] \
   && grep -qx 'legacy' "$WTR/mig5/theme-pre/.claude/tasks/OLD-5/notes.md" 2>/dev/null; then ok
else bad W30d-worktree-link-repointed "rc=$rc pre=$(ls -l "$WTR/mig5/theme-pre/.claude" 2>&1 | tr '\n' ';')"; fi

# W30e: …and a worktree that ALREADY has a real `.claude/tasks` keeps it — the never-merge rule
# of the rename applies to the re-point too.
mk_mig_repo "$WTR/mig6"
mkdir -p "$WTR/mig6/theme/.claude/fnd/OLD-6"
printf 'legacy\n' > "$WTR/mig6/theme/.claude/fnd/OLD-6/notes.md"
wt_git -C "$WTR/mig6/theme" worktree add -q -b feat/pre-rename "$WTR/mig6/theme-pre" >/dev/null 2>&1
mkdir -p "$WTR/mig6/theme-pre/.claude/tasks/OWN-6"
printf 'own\n' > "$WTR/mig6/theme-pre/.claude/tasks/OWN-6/notes.md"
ln -s "$WTR/mig6/theme/.claude/fnd" "$WTR/mig6/theme-pre/.claude/fnd"
rc=0; mig_run "$WTR/mig6" MIG-6 || rc=$?
if [ "$rc" -eq 0 ] && [ ! -L "$WTR/mig6/theme-pre/.claude/tasks" ] \
   && grep -qx 'own' "$WTR/mig6/theme-pre/.claude/tasks/OWN-6/notes.md" 2>/dev/null \
   && [ -L "$WTR/mig6/theme-pre/.claude/fnd" ]; then ok
else bad W30e-worktree-own-tasks-kept "rc=$rc pre=$(ls -l "$WTR/mig6/theme-pre/.claude" 2>&1 | tr '\n' ';')"; fi

# W31 (bug): two setups running at once used to share a port — the pick happened before
# `worktree add` and the `dev-port:` line landed only after `npm ci`, so a second setup started
# during the (minutes-long) install counted nothing. RACE-1 is frozen inside `npm ci` by the shim
# while RACE-2 runs to completion; the poll waits for RACE-1's claim, which the fixed script
# writes before the install (on a regressed tree it times out after ~5 s and RACE-2 collides).
mk_mig_repo "$WTR/race"
printf '{"name":"x","private":true}\n' > "$WTR/race/theme/package.json"
wt_git -C "$WTR/race/theme" add -A
wt_git -C "$WTR/race/theme" commit -qm pkg
wt_git -C "$WTR/race/theme" push -q origin develop
RACE_MK="$TMP/race.npm.mark"; rm -f "$RACE_MK"
RACE1_NOTES="$WTR/race/theme/.claude/tasks/RACE-1/notes.md"
(cd "$WTR/race/theme" && HOME="$WTR/home" GIT_CONFIG_NOSYSTEM=1 PATH="$WTR/shim:$PATH" \
   WT_NPM_WAIT="$RACE_MK" WT_NPM_LOG=/dev/null "$BASH_BIN" "$WTS" RACE-1) >"$TMP/race1.out" 2>&1 &
RACE_PID=$!
i=0
while [ "$i" -lt 50 ] && ! grep -q 'dev-port:' "$RACE1_NOTES" 2>/dev/null; do sleep 0.1; i=$((i + 1)); done
rc=0; mig_run "$WTR/race" RACE-2 || rc=$?
wt_race2="$(wt_key dev_port)"
: > "$RACE_MK"
rc1=0; wait "$RACE_PID" || rc1=$?
wt_race1_rec="$(grep -oE 'dev-port: [0-9]+' "$RACE1_NOTES" 2>/dev/null | tail -1 | tr -dc '0-9')"
wt_race1_out="$(grep '^dev_port=' "$TMP/race1.out" | cut -d= -f2)"
if [ "$rc" -eq 0 ] && [ "$rc1" -eq 0 ] && [ -n "$wt_race1_rec" ] && [ "$wt_race1_rec" = "$wt_race1_out" ] \
   && [ -n "$wt_race2" ] && [ "$wt_race2" != "$wt_race1_rec" ] \
   && grep -q '^npm=installed$' "$TMP/race1.out" && grep -q '^npm=installed$' "$O"; then ok
else bad W31-port-race-parallel-setups "rc=$rc/$rc1 race1=$wt_race1_out rec=$wt_race1_rec race2=$wt_race2 out1=$(tr '\n' ';' < "$TMP/race1.out") out2=$(tr '\n' ';' < "$O")"; fi

# W31b: the claim is on disk when `npm ci` starts (one `dev-port:` line, seen by the shim from
# inside the install) and is not written a second time afterwards.
RACE3_NOTES="$WTR/race/theme/.claude/tasks/RACE-3/notes.md"
RACE3_LOG="$TMP/race3.npm.log"; : > "$RACE3_LOG"
rc=0; (cd "$WTR/race/theme" && HOME="$WTR/home" GIT_CONFIG_NOSYSTEM=1 PATH="$WTR/shim:$PATH" \
   WT_NPM_NOTES="$RACE3_NOTES" WT_NPM_LOG="$RACE3_LOG" "$BASH_BIN" "$WTS" RACE-3) >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -qx 'dev-port-lines=1' "$RACE3_LOG" \
   && [ "$(grep -c 'dev-port:' "$RACE3_NOTES" 2>/dev/null)" -eq 1 ] \
   && grep -qE "dev-port: $(wt_key dev_port)\$" "$RACE3_NOTES"; then ok
else bad W31b-port-recorded-before-npm "rc=$rc log=$(tr '\n' ';' < "$RACE3_LOG") notes=$(tr '\n' ';' < "$RACE3_NOTES" 2>&1) out=$(tr '\n' ';' < "$O")"; fi

# W32: the second port pass — every port in the range is recorded by a LIVE registered worktree
# (W24's stale claims never get here), nothing is listening, so the setup is still handed a port,
# the first one the live probe clears, and SAYS the claim may collide. Reaching it with the real
# 20-port range would need 20 worktrees, so the copy under test has PORT_LAST narrowed to a 2-port
# range (W26's pattern); a per-case repo keeps its bookkeeping away from wt_next_port.
WTS_NAR="$WTR/worktree-setup-narrow.sh"
sed 's/^PORT_LAST=.*/PORT_LAST=9294/' "$WTS" > "$WTS_NAR"
mk_mig_repo "$WTR/nar"
nar_run() { # <args…> — the narrowed copy against the per-case repo
  (cd "$WTR/nar/theme" && HOME="$WTR/home" GIT_CONFIG_NOSYSTEM=1 PATH="$WTR/shim:$PATH" \
     "$BASH_BIN" "$WTS_NAR" "$@") >"$O" 2>"$E"
}
rc=0; nar_run NAR-1 || rc=$?; wt_nar1="$(wt_key dev_port)"
rc2=0; nar_run NAR-2 || rc2=$?; wt_nar2="$(wt_key dev_port)"
rc3=0; nar_run NAR-3 || rc3=$?; wt_nar3="$(wt_key dev_port)"
if [ "$rc" -eq 0 ] && [ "$rc2" -eq 0 ] && [ "$rc3" -eq 0 ] && grep -q '^PORT_LAST=9294$' "$WTS_NAR" \
   && [ "$wt_nar1" = 9293 ] && [ "$wt_nar2" = 9294 ] && [ "$wt_nar3" = 9293 ] \
   && [ "$(grep -c '^warn=port_range_crowded range=9293-9294' "$O")" -eq 1 ] \
   && grep -qE 'dev-port: 9293$' "$WTR/nar/theme/.claude/tasks/NAR-3/notes.md"; then ok
else bad W32-second-port-pass "rc=$rc/$rc2/$rc3 ports=$wt_nar1/$wt_nar2/$wt_nar3 out=$(tr '\n' ';' < "$O")"; fi
# W32b: … and with something listening on every port too, the refusal is named and nothing is
# created (the pick runs before `worktree add`)
wt_listen 9293; wt_listen2 9294
rc=0; nar_run NAR-4 || rc=$?
if [ "$rc" -ne 0 ] && grep -q '^error=no_free_port range=9293-9294' "$O" \
   && [ ! -d "$WTR/nar/theme-NAR-4" ] && ! grep -qs 'dev-port:' "$WTR/nar/theme/.claude/tasks/NAR-4/notes.md"; then ok
else bad W32b-no-free-port "rc=$rc out=$(tr '\n' ';' < "$O") wt=$([ -d "$WTR/nar/theme-NAR-4" ] && echo yes || echo no)"; fi
wt_unlisten

# ═══ EV — domaine env files: scripts/env-file.cjs loader + scripts/domaine-env.cjs CLI ═══
EVR="$TMP/env"; mkdir -p "$EVR/cfg" "$EVR/repo/sub"
git init -q "$EVR/repo"
EVF="$ROOT/plugins/fnd/scripts/env-file.cjs"
EVC="$ROOT/plugins/fnd/scripts/domaine-env.cjs"

# EV1: `set` writes the global file; `set --project` targets <git toplevel>/.claude/domaine.env
# (with a PROJECT_OK key — the project layer takes tuning switches only, EV6)
(cd "$EVR/repo" && XDG_CONFIG_HOME="$EVR/cfg" node "$EVC" set FND_MCP_SLIM_DEBUG=1 >/dev/null \
  && XDG_CONFIG_HOME="$EVR/cfg" node "$EVC" set FND_MCP_SLIM_TTL=12 >/dev/null \
  && XDG_CONFIG_HOME="$EVR/cfg" node "$EVC" set FND_CTX_WARN=48 --project >/dev/null)
if grep -qx 'FND_MCP_SLIM_DEBUG=1' "$EVR/cfg/domaine/env" \
   && grep -qx 'FND_MCP_SLIM_TTL=12' "$EVR/cfg/domaine/env" \
   && grep -qx 'FND_CTX_WARN=48' "$EVR/repo/.claude/domaine.env"; then ok
else bad EV1-cli-set "global=$(tr '\n' ';' < "$EVR/cfg/domaine/env" 2>&1) project=$(tr '\n' ';' < "$EVR/repo/.claude/domaine.env" 2>&1)"; fi

# EV2: loader precedence from a SUBDIR (walk-up finds the project file): project beats global,
# a real process-env value beats both
o1="$(cd "$EVR/repo/sub" && XDG_CONFIG_HOME="$EVR/cfg" node -e \
  'require(process.argv[1]).load(); console.log(process.env.FND_MCP_SLIM_DEBUG+"|"+process.env.FND_CTX_WARN)' "$EVF")"
o2="$(cd "$EVR/repo/sub" && XDG_CONFIG_HOME="$EVR/cfg" FND_CTX_WARN=7 node -e \
  'require(process.argv[1]).load(); console.log(process.env.FND_CTX_WARN)' "$EVF")"
if [ "$o1" = "1|48" ] && [ "$o2" = "7" ]; then ok; else bad EV2-precedence "o1=$o1 o2=$o2"; fi

# EV3: the allowlist — PATH/NODE_OPTIONS in the file never reach process.env, and the CLI
# refuses to write them; malformed lines and comments are skipped without error
printf '# tuning\nPATH=/evil\nNODE_OPTIONS=--bad\nnot a pair\nFND_WHALE_GUIDE=0\n' > "$EVR/cfg/domaine/env"
o3="$(cd "$EVR/cfg" && XDG_CONFIG_HOME="$EVR/cfg" node -e \
  'require(process.argv[1]).load(); console.log((process.env.PATH.includes("/evil")?"evil":"clean")+"|"+process.env.FND_WHALE_GUIDE+"|"+(process.env.NODE_OPTIONS||"unset"))' "$EVF")"
rc=0; XDG_CONFIG_HOME="$EVR/cfg" node "$EVC" set PATH=/evil >/dev/null 2>&1 || rc=$?
if [ "$o3" = "clean|0|unset" ] && [ "$rc" -ne 0 ]; then ok; else bad EV3-allowlist "o3=$o3 rc=$rc"; fi

# EV4: `unset` removes only the key line — comments and unknown lines survive; `list` names
# the source that won
XDG_CONFIG_HOME="$EVR/cfg" node "$EVC" unset FND_WHALE_GUIDE >/dev/null
o4="$(cd "$EVR/repo" && XDG_CONFIG_HOME="$EVR/cfg" node "$EVC" list)"
if grep -qx '# tuning' "$EVR/cfg/domaine/env" && ! grep -q 'FND_WHALE_GUIDE' "$EVR/cfg/domaine/env" \
   && printf '%s' "$o4" | grep -q 'FND_CTX_WARN.*= 48.*(project file)'; then ok
else bad EV4-unset-list "file=$(tr '\n' ';' < "$EVR/cfg/domaine/env") list=$(printf '%s' "$o4" | grep FND_CTX_WARN)"; fi

# EV5: the bash-side reader — the domaine_env function create-preview-theme.sh and
# shopify-admin-gql.sh source from _shopify-common.sh (extracted from the shipped file, so this
# tests the real code): project-first walk-up, first-'=' split, values with spaces intact
eval "$(sed -n '/^domaine_env()/,/^}/p' "$COMMON")"
printf 'FND_CPT_THROTTLE_WAITS=5 9\n' > "$EVR/repo/.claude/domaine.env"
o5="$(cd "$EVR/repo/sub" && XDG_CONFIG_HOME="$EVR/cfg" domaine_env FND_CPT_THROTTLE_WAITS)"
o6="$(cd "$EVR/cfg" && XDG_CONFIG_HOME="$EVR/cfg" domaine_env FND_MCP_SLIM_DEBUG)"
if [ "$o5" = "5 9" ] && [ "$o6" = "" ]; then ok; else bad EV5-bash-reader "o5='$o5' o6='$o6'"; fi

# EV5b: single home — a private domaine_env() in either script would let the two allowlists drift
if [ "$(cat "$CPT" "$GQL" | grep -c '^domaine_env() {')" -eq 0 ] && [ -n "$(type -t domaine_env)" ]; then ok
else bad EV5b-domaine-env-single-home "domaine_env() is defined outside _shopify-common.sh (or the lib's copy did not load)"; fi

# EV6: the project layer is a file a CLIENT REPO can commit, so it carries env-file.cjs's
# PROJECT_OK tuning keys and nothing else — a security switch in it is skipped by the loader
# (reported back as `ignored` for a caller that wants to say so; hooks stay silent), while the same
# key still works from the global file. Default-deny: an unlisted FND_* key is global-only too.
EV2R="$TMP/env2"; mkdir -p "$EV2R/cfg/domaine" "$EV2R/repo/.claude"
git init -q "$EV2R/repo"
printf 'FND_MCP_SLIM=0\nFND_MCP_SLIM_DIR=/tmp/evil\nFND_FUTURE_SWITCH=0\nFND_CTX_WARN=11\n' \
  > "$EV2R/repo/.claude/domaine.env"
printf 'FND_MCP_SLIM_DIR=/tmp/good\n' > "$EV2R/cfg/domaine/env"
o7="$(cd "$EV2R/repo" && XDG_CONFIG_HOME="$EV2R/cfg" node -e \
  'const r = require(process.argv[1]).load();
   console.log([process.env.FND_MCP_SLIM || "unset", process.env.FND_MCP_SLIM_DIR,
                process.env.FND_CTX_WARN, r.ignored.map((i) => i.key).sort().join(",")].join("|"))' "$EVF")"
if [ "$o7" = "unset|/tmp/good|11|FND_FUTURE_SWITCH,FND_MCP_SLIM,FND_MCP_SLIM_DIR" ]; then ok
else bad EV6-project-class-split "o7=$o7"; fi

# EV6b: `list` says so where the developer looks for the value — a key that only the project file
# carries names the class, and one the global file also carries shows the winner plus the dead line
o8="$(cd "$EV2R/repo" && XDG_CONFIG_HOME="$EV2R/cfg" node "$EVC" list)"
if printf '%s' "$o8" | grep -q 'FND_MCP_SLIM .*= 0.*(project (ignored: global-only switch))' \
   && printf '%s' "$o8" | grep -q 'FND_MCP_SLIM_DIR .*= /tmp/good.*(global file).*\[project (ignored: global-only switch): /tmp/evil\]' \
   && printf '%s' "$o8" | grep -q 'FND_CTX_WARN .*= 11.*(project file)'; then ok
else bad EV6b-list-ignored "$(printf '%s' "$o8" | grep 'FND_MCP_SLIM\|FND_CTX_WARN' | tr '\n' ';' | head -c 300)"; fi

# EV6c: and the CLI will not write one in the first place — exit 2 (not die()'s 1), naming the
# command that does work; `unset --project` still works, so a file that predates this can be cleaned
rc=0; (cd "$EV2R/repo" && XDG_CONFIG_HOME="$EV2R/cfg" node "$EVC" set FND_SCRATCH_GUARD=0 --project) \
  >/dev/null 2>"$E" || rc=$?
if [ "$rc" -eq 2 ] && grep -q 'global-only switch' "$E" && grep -q 'without --project' "$E" \
   && ! grep -q FND_SCRATCH_GUARD "$EV2R/repo/.claude/domaine.env"; then ok
else bad EV6c-set-project-refused "rc=$rc err=$(head -c 200 "$E" | tr '\n' ' ')"; fi
rc=0; (cd "$EV2R/repo" && XDG_CONFIG_HOME="$EV2R/cfg" node "$EVC" unset FND_MCP_SLIM --project) \
  >/dev/null 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && ! grep -q '^FND_MCP_SLIM=' "$EV2R/repo/.claude/domaine.env"; then ok
else bad EV6d-unset-project-still-works "rc=$rc file=$(tr '\n' ';' < "$EV2R/repo/.claude/domaine.env")"; fi

# EV7: the bash reader carries the same split by hand — a global-only key is not even looked for in
# the project file (the global value wins), a PROJECT_OK key still comes from the project layer
printf 'FND_MCP_SLIM_DIR=/tmp/evil\nFND_CPT_OVERLAY_VERIFY=0\nFND_CPT_OVERLAY_VERIFY_WAIT=9\n' \
  > "$EV2R/repo/.claude/domaine.env"
printf 'FND_MCP_SLIM_DIR=/tmp/good\nFND_CPT_OVERLAY_VERIFY=1\n' > "$EV2R/cfg/domaine/env"
o9="$(cd "$EV2R/repo" && XDG_CONFIG_HOME="$EV2R/cfg" domaine_env FND_MCP_SLIM_DIR)"
o10="$(cd "$EV2R/repo" && XDG_CONFIG_HOME="$EV2R/cfg" domaine_env FND_CPT_OVERLAY_VERIFY)"
o11="$(cd "$EV2R/repo" && XDG_CONFIG_HOME="$EV2R/cfg" domaine_env FND_CPT_OVERLAY_VERIFY_WAIT)"
if [ "$o9" = "/tmp/good" ] && [ "$o10" = "1" ] && [ "$o11" = "9" ]; then ok
else bad EV7-bash-class-split "dir='$o9' verify='$o10' wait='$o11'"; fi

echo "scripts-sim: $pass passed, $fail failed"
if [ "$fail" -gt 0 ]; then printf '%s' "$failures"; exit 1; fi
