#!/usr/bin/env bash
# Simulation harness for fe's bundled scripts (plugins/fe/scripts and the fix-breaking-changes
# skill script). No network, no store: theme-json runs against a stub runner; shopify-admin-gql
# runs against PATH shims of `shopify` and `curl`; worktree-theme runs on scratch git repos.
# Exit 0 = all green.
set -u

# Hermetic env: the store/token vars are read as an escape hatch by the scripts under test, so an
# exported real token would
# reach the fake CLI (and the case's argv log) instead of the fixture value; SHOPIFY_ADMIN_API_VERSION
# is the same kind of hatch, and its whole point is to displace the default version G47c pins. Same
# for the two switches README tells developers to keep in settings.json → "env" (which Claude Code
# exports to the Bash tool): FE_GQL_PROBE_CACHE=0 turns the probe-cache cases red, and an ambient
# TOML_PATH re-targets every case that relies on the repo fixture toml. FE_PROFILE is the same
# hazard one level up: it is the profile probe's own override, so an exported one would answer
# every PP case before detection ever ran.
unset SHOPIFY_CLI_THEME_TOKEN SHOPIFY_STORE \
      FE_GQL_PROBE_CACHE TOML_PATH SHOPIFY_ADMIN_API_VERSION SHOPIFY_FLAG_ENVIRONMENT \
      FE_PROFILE FE_CPT_THROTTLE_WAITS FE_CPT_OVERLAY_VERIFY FE_CPT_OVERLAY_VERIFY_WAIT \
      FE_THEME_JSON_VERIFY FE_THEME_JSON_VERIFY_WAIT

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GQL="$ROOT/plugins/fe/scripts/shopify-admin-gql.sh"
TJ="$ROOT/plugins/fe/scripts/theme-json.sh"
CPT="$ROOT/plugins/fe/scripts/create-preview-theme.sh"
COMMON="$ROOT/plugins/fe/scripts/_shopify-common.sh"
WTT="$ROOT/plugins/fe/scripts/worktree-theme.sh"
STL="$ROOT/plugins/fe/scripts/session-theme.sh"
FBC="$ROOT/plugins/fe/skills/fix-breaking-changes/scripts/fix-breaking-changes.template.js"
BASH_BIN="$(command -v bash)"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# A real ~/.config/domaine/env on this machine would inject switches into every case (the
# scripts under test read it via domaine_env) — point the global layer at a
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

# A PATH of symlinks to exactly the tools a script uses is the only way to make `command -v <x>`
# fail on a normal machine (the degradation cases: no perl, no node). The omitted tool is filtered
# out of the list too, so a later edit of a list cannot silently put it back.
path_without() { # path_without <dir> <tool-to-omit> <tools…>
  local dir="$1" omit="$2" b p
  shift 2
  mkdir -p "$dir"
  for b in "$@"; do
    [ "$b" = "$omit" ] && continue
    p="$(command -v "$b" 2>/dev/null)" && ln -sf "$p" "$dir/$b"
  done
  return 0
}

# ---------------------------------------------- theme-json.sh against a stub runner --
TJDIR="$TMP/tj"; mkdir -p "$TJDIR"
cp "$TJ" "$TJDIR/theme-json.sh"
cp "$COMMON" "$TJDIR/"   # sourced from the script's own dir — every fixture copy needs it beside
cat > "$TJDIR/shopify-admin-gql.sh" <<'STUB'
#!/usr/bin/env bash
# stub runner — answers by query content; FAKE_ROLE controls the theme role,
# FAKE_RUNNER_MODE simulates the runner's exit-3 stderr contracts. TJ_GQL_LOG records one argv line
# per call — the --file vetting cases assert the OPPOSITE (nothing was read or written), and "no
# output" alone would also be what a broken stub looks like; T52 reads the line itself.
set -u
if [ -n "${TJ_GQL_LOG:-}" ]; then printf '%s\n' "$*" >> "$TJ_GQL_LOG"; fi
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
if grep -q FeThemesList "$Q"; then
  printf '{"data":{"themes":{"nodes":[{"id":"gid://shopify/OnlineStoreTheme/1","name":"Live","role":"MAIN"},{"id":"gid://shopify/OnlineStoreTheme/2","name":"Dev","role":"DEVELOPMENT"}]}}}\n'
elif grep -q FeThemeFileGet "$Q"; then
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
elif grep -q FeThemeMeta "$Q"; then
  printf '{"data":{"theme":{"id":"gid://shopify/OnlineStoreTheme/2","name":"Dev","role":"%s"}}}\n' "$role"
elif grep -q FeThemeFileSet "$Q"; then
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
# T5b (bug): the gql guard compared the role literally against MAIN, so every other spelling the
# Admin API or a cached listing can carry walked straight into a live-theme write. It now shares
# the themecli branch's rule (live|main, any case).
for r in main Main live Live; do
  rc=0; FAKE_ROLE="$r" "$BASH_BIN" "$TJDIR/theme-json.sh" set --theme 2 --file templates/product.json \
    --from "$TMP/snap.json" >"$O" 2>"$E" || rc=$?
  assert "T5b-gql-live-refused-$r" 4 "$rc" "$E" "live_theme_write_refused"
done
# T5c: a non-live role still writes — the widened rule must not swallow the ordinary target
rc=0; FAKE_ROLE=UNPUBLISHED "$BASH_BIN" "$TJDIR/theme-json.sh" set --theme 2 --file templates/product.json \
  --from "$TMP/snap.json" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -q '"ok":"upserted"' "$O"; then ok
else bad T5c-gql-unpublished-writes "rc=$rc out=$(head -c 160 "$O") err=$(head -c 160 "$E" | tr '\n' ' ')"; fi

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
# only way to assert that FE_THEME_JSON_VERIFY=0 pulls nothing. With no body set the pull
# "succeeds" and produces no file (the unreadable-read-back path). TJ_PUSH_SAVE captures the
# pushed bytes (point TJ_PULL_BODY at it for the round-trip); TJ_PUSH_JSON overrides the
# --json envelope the push prints. TJ_PULL_FAIL makes every pull fail the way a 503 does.
# TJ_LIST_FAIL / TJ_PULL_FAIL / TJ_PUSH_FAIL make that call fail: `401` reproduces the CLI's
# box-drawing auth rejection (a Theme Access token minted for a DIFFERENT store); for list, `reqid`
# and `ts` are plain failures whose text merely contains the digits 401; anything else is a plain
# failure (a pull's is the 503 shape).
path=""; only=""; prev=""
for a in "$@"; do
  case "$prev" in --path) path="$a" ;; --only) only="$a" ;; esac
  prev="$a"
done
case "$*" in
  *"theme list"*)
    case "${TJ_LIST_FAIL:-}" in
      '') ;;
      401) printf '%s\n' '╭─ error ───────────────────────────────╮' \
                          '│                                       │' \
                          '│  401 undefined                        │' \
                          '│                                       │' \
                          '╰───────────────────────────────────────╯' >&2; exit 1 ;;
      reqid) echo 'Error: network unreachable (request_id: 7d401ef2-aaaa)' >&2; exit 1 ;;
      ts)  echo 'Error: push failed at 12:34:56.401 (id ab-401-cd)' >&2; exit 1 ;;
      *)   echo 'Error: getaddrinfo ENOTFOUND (network unreachable)' >&2; exit 1 ;;
    esac
    if [ -n "${TJ_LIST_JSON:-}" ]; then printf '%s\n' "$TJ_LIST_JSON"
    else printf '[{"id":2,"name":"Dev","role":"development"}]\n'; fi ;;
  *"theme push"*)
    [ "${TJ_PUSH_FAIL:-}" = 401 ] && { printf '%s\n' '│  401 undefined  │' >&2; exit 1; }
    if [ -n "${TJ_PUSH_SAVE:-}" ] && [ -n "$path" ] && [ -n "$only" ]; then cp "$path/$only" "$TJ_PUSH_SAVE"; fi
    pj="${TJ_PUSH_JSON:-}"; [ -n "$pj" ] || pj='{}'
    printf '%s\n' "$pj" ;;
  *"theme pull"*)
    [ "${TJ_PULL_FAIL:-}" = 401 ] && { printf '%s\n' '│  401 undefined  │' >&2; exit 1; }
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

# --- multi-environment toml: one block supplies the store AND the token -------------------
# `--env` here names the DOTENV file, not a toml block, so the selector is $SHOPIFY_FLAG_ENVIRONMENT
# (what `shopify theme dev -e` reads) with the same dev/development/top-level default as the pin.
# A file-ordered read handed the CLI one environment's store with another's token — and a Theme
# Access token is minted per store, so that is a 401 at best and the wrong store at worst.
printf '[environments.production]\nstore = "store-a"\npassword = "shptka_prodAAA"\n\n[environments.dev]\nstore = "store-b"\npassword = "shptka_devBBB"\n' > "$TT/two.toml"
rc=0; L="$TMP/tjl60"; : > "$L"
TOML_PATH="$TT/two.toml" TJ_CLI_LOG="$L" PATH="$TJSHIM:$PATH" \
  "$BASH_BIN" "$TJDIR/theme-json.sh" themes --engine themecli >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -q 'argv=.*--store store-b\.myshopify\.com ' "$L" \
   && grep -q '^token=shptka_devBBB$' "$L" && ! grep -q 'shptka_prodAAA' "$L"; then ok
else bad T60-toml-block-store-and-token "rc=$rc log=$(grep -v token "$L" | tr '\n' ';') err=$(head -c 160 "$E" | tr '\n' ' ')"; fi

# T60b: $SHOPIFY_FLAG_ENVIRONMENT picks the other block, store and token together
rc=0; L="$TMP/tjl60b"; : > "$L"
TOML_PATH="$TT/two.toml" SHOPIFY_FLAG_ENVIRONMENT=production TJ_CLI_LOG="$L" PATH="$TJSHIM:$PATH" \
  "$BASH_BIN" "$TJDIR/theme-json.sh" themes --engine themecli >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -q 'argv=.*--store store-a\.myshopify\.com ' "$L" \
   && grep -q '^token=shptka_prodAAA$' "$L" && ! grep -q 'shptka_devBBB' "$L"; then ok
else bad T60b-flag-environment "rc=$rc log=$(grep -v token "$L" | tr '\n' ';') err=$(head -c 160 "$E" | tr '\n' ' ')"; fi

# T60c (blocker): blocks naming different stores and none of them dev/development — refused before
# the CLI runs, with the escape hatches spelled out (this script's --env is not one of them)
printf '[environments.production]\nstore = "store-a"\npassword = "shptka_prodAAA"\n\n[environments.staging]\nstore = "store-c"\npassword = "shptka_stgCCC"\n' > "$TT/diff.toml"
rc=0; L="$TMP/tjl60c"; : > "$L"
TOML_PATH="$TT/diff.toml" TJ_CLI_LOG="$L" PATH="$TJSHIM:$PATH" \
  "$BASH_BIN" "$TJDIR/theme-json.sh" themes --engine themecli >"$O" 2>"$E" || rc=$?
assert T60c-tj-ambiguous-env 2 "$rc" "$E" "error=ambiguous_env envs=production staging"
if [ ! -s "$L" ] && grep -q 'SHOPIFY_FLAG_ENVIRONMENT=<name>' "$E"; then ok
else bad T60d-tj-ambiguous-no-cli "the CLI ran, or the hint named no selector :: $(tr '\n' ';' < "$L") $(head -c 200 "$E" | tr '\n' ' ')"; fi

# T60e (bug): `pass --store` is the first escape hatch the refusal names, so it has to WORK — a
# store the run is already fixed on answers the question the ambiguity was about, and the token
# then comes from the block naming THAT store (never a borrowed one)
rc=0; L="$TMP/tjl60e"; : > "$L"
TOML_PATH="$TT/diff.toml" TJ_CLI_LOG="$L" PATH="$TJSHIM:$PATH" \
  "$BASH_BIN" "$TJDIR/theme-json.sh" themes --engine themecli --store store-a >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -q 'argv=.*--store store-a\.myshopify\.com ' "$L" \
   && grep -q '^token=shptka_prodAAA$' "$L" && ! grep -q 'shptka_stgCCC' "$L"; then ok
else bad T60e-store-flag-settles-block "rc=$rc log=$(grep -v token "$L" | tr '\n' ';') err=$(head -c 200 "$E" | tr '\n' ' ')"; fi

# T60f: …and only when a block actually names it — a --store no block carries leaves the token
# question open, so the refusal stands and nothing is invoked with a borrowed token
rc=0; L="$TMP/tjl60f"; : > "$L"
TOML_PATH="$TT/diff.toml" TJ_CLI_LOG="$L" PATH="$TJSHIM:$PATH" \
  "$BASH_BIN" "$TJDIR/theme-json.sh" themes --engine themecli --store store-zzz >"$O" 2>"$E" || rc=$?
assert T60f-tj-unknown-store-still-refused 2 "$rc" "$E" "error=ambiguous_env"
if [ ! -s "$L" ]; then ok; else bad T60f2-tj-unknown-store-no-cli "the CLI ran with a borrowed token :: $(tr '\n' ';' < "$L")"; fi

# T60h (bug): on the auto engine cli_token_ready is a PROBE — "is there a theme token to fall back
# on?" — and an unresolvable block is "no", never a reason to abort. Aborting there replaced the
# gql engine's own diagnosis (the credential lacks the theme scopes) with an unrelated config line.
rc=0; L="$TMP/tjl60h"; : > "$L"
TOML_PATH="$TT/diff.toml" FAKE_RUNNER_MODE=denied TJ_CLI_LOG="$L" PATH="$TJSHIM:$PATH" \
  "$BASH_BIN" "$TJDIR/theme-json.sh" get --theme 2 --file templates/product.json >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 5 ] && grep -q 'read_themes/write_themes' "$E" \
   && ! grep -q 'ambiguous_env' "$E" && [ ! -s "$L" ]; then ok
else bad T60h-probe-keeps-gql-diagnosis "rc=$rc err=$(head -c 220 "$E" | tr '\n' ' ')"; fi

# T60i: and with the store fixed, that same probe answers YES — the fallback runs against store-a
# with store-a's own token, exactly as it does on a single-environment toml
rc=0; L="$TMP/tjl60i"; : > "$L"
TOML_PATH="$TT/diff.toml" FAKE_RUNNER_MODE=nocreds TJ_CLI_LOG="$L" PATH="$TJSHIM:$PATH" \
  "$BASH_BIN" "$TJDIR/theme-json.sh" themes --store store-a >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -q 'note=gql engine unavailable' "$E" \
   && grep -q 'argv=theme list --store store-a\.myshopify\.com ' "$L" \
   && grep -q '^token=shptka_prodAAA$' "$L" && ! grep -q 'shptka_stgCCC' "$L"; then ok
else bad T60i-probe-falls-back-with-store "rc=$rc log=$(grep -v token "$L" | tr '\n' ';') err=$(head -c 220 "$E" | tr '\n' ' ')"; fi

# T60g (drift guard): the block resolver has ONE home for the same reason the scalar reader does —
# a second copy is two scripts free to disagree about which store a toml resolves to
if [ "$(grep -cE '^toml_(resolve_env|env_pick_by_store)\(\) \{' "$COMMON")" -eq 2 ] \
   && [ "$(cat "$TJ" "$CPT" "$GQL" "$WTT" "$STL" | grep -cE '^toml_(resolve_env|env_pick_by_store)\(\) \{')" -eq 0 ]; then ok
else bad T60g-block-resolver-single-home "a block resolver is defined outside _shopify-common.sh (or missing from it)"; fi

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
   && [ "$(cat "$TJ" "$CPT" "$GQL" "$WTT" "$STL" | grep -c '^toml_value() {')" -eq 0 ]; then ok
else bad T31-toml-reader-single-home "toml_value() is defined outside _shopify-common.sh (or missing from it)"; fi
# T31b: the three theme scripts source the lib from their own dir; worktree-theme.sh shares nothing
# with it and stays lib-free — the siblings it touches are run as subprocesses (T31f)
if grep -q '^\. "\$SCRIPT_DIR/_shopify-common\.sh"$' "$TJ" && grep -q '^\. "\$SCRIPT_DIR/_shopify-common\.sh"$' "$CPT" \
   && grep -q '^\. "\$SCRIPT_DIR/_shopify-common\.sh"$' "$GQL" && ! grep -q '_shopify-common' "$WTT"; then ok
else bad T31b-common-lib-sourced "expected cpt/tj/gql to source _shopify-common.sh and worktree-theme.sh not to"; fi
# T31c: the sourcing is real, not vacuous — a copy without the lib beside it stops with its own
# error= line (exit 2 on the stderr scripts) before any engine runs
LONE="$TMP/lone"; mkdir -p "$LONE"; cp "$TJ" "$LONE/theme-json.sh"; cp "$GQL" "$LONE/shopify-admin-gql.sh"
rc=0; "$BASH_BIN" "$LONE/theme-json.sh" themes >"$O" 2>"$E" || rc=$?
assert T31c-tj-common-lib-missing 2 "$rc" "$E" "error=common_lib_not_found path=$LONE/_shopify-common.sh"
rc=0; "$BASH_BIN" "$LONE/shopify-admin-gql.sh" --query "$TJDIR/theme-json.sh" >"$O" 2>"$E" || rc=$?
assert T31d-gql-common-lib-missing 2 "$rc" "$E" "error=common_lib_not_found path=$LONE/_shopify-common.sh"
# T31e (drift guard): the `# fe:superseded` / `# fe:session-theme` grammar has ONE home — a
# second copy of the strings, or of either toml rewriter, is two writers free to disagree
if [ "$(grep -lE 'fe:(superseded|session-theme)' "$ROOT"/plugins/fe/scripts/*.sh | wc -l | tr -d ' ')" -eq 1 ] \
   && grep -qE 'fe:(superseded|session-theme)' "$STL" \
   && [ "$(grep -c '^pin_toml() {' "$STL")" -eq 1 ] && [ "$(grep -c '^unpin_toml() {' "$STL")" -eq 1 ] \
   && [ "$(grep -c '^shared_dev_theme_ids() {' "$STL")" -eq 1 ] \
   && [ "$(cat "$CPT" "$WTT" "$TJ" "$GQL" "$COMMON" | grep -cE '^(un)?pin_toml\(\) \{|^shared_dev_theme_ids\(\) \{')" -eq 0 ]; then ok
else bad T31e-marker-grammar-single-home "the pin/un-pin marker grammar is written in more than one script"; fi
# T31f: and both callers really reach that home — cpt sources it, worktree-theme.sh runs it
if grep -q '^\. "\$SCRIPT_DIR/session-theme\.sh"$' "$CPT" && grep -q 'bash "\$SESSION_LIB" unpin' "$WTT"; then ok
else bad T31f-session-lib-wired "expected cpt to source session-theme.sh and worktree-theme.sh to run it"; fi

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

# T61 (bug): the Bash tool's cwd persists, so a run started inside `.claude/tasks/<id>/tmp` looked
# for ./shopify.theme.toml there and died `error=no_store`. With no TOML_PATH the nearest toml up
# to the checkout root (the first `.git` above the cwd) is the one read.
T61="$TMP/t61"; mkdir -p "$T61/repo/.claude/tasks/ABC-1/tmp" "$T61/nogit/.claude/tasks/ABC-1/tmp"
git -C "$T61/repo" init -q 2>/dev/null
printf '[environments.development]\nstore = "acme-root"\npassword = "shptka_fixture1234"\n' > "$T61/repo/shopify.theme.toml"
cp "$T61/repo/shopify.theme.toml" "$T61/nogit/shopify.theme.toml"
rc=0; L="$TMP/tjl61"; : > "$L"
(cd "$T61/repo/.claude/tasks/ABC-1/tmp" && TJ_CLI_LOG="$L" PATH="$TJSHIM:$PATH" \
  "$BASH_BIN" "$TJDIR/theme-json.sh" themes --engine themecli) >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -q 'argv=.*--store acme-root\.myshopify\.com ' "$L"; then ok
else bad T61-toml-from-task-subdir "rc=$rc log=$(grep -v token "$L" | tr '\n' ';') err=$(head -c 160 "$E" | tr '\n' ' ')"; fi
# T61b: an explicit TOML_PATH still wins over the walk
rc=0; L="$TMP/tjl61b"; : > "$L"
(cd "$T61/repo/.claude/tasks/ABC-1/tmp" && TOML_PATH="$TT/bare.toml" TJ_CLI_LOG="$L" PATH="$TJSHIM:$PATH" \
  "$BASH_BIN" "$TJDIR/theme-json.sh" themes --engine themecli) >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -q 'argv=.*--store acme-bare\.myshopify\.com ' "$L"; then ok
else bad T61b-toml-path-wins "rc=$rc log=$(grep -v token "$L" | tr '\n' ';')"; fi
# T61c: outside any checkout nothing is walked — the cwd-relative lookup and its refusal, which now
# names the absolute path it tried and the two ways out
rc=0; L="$TMP/tjl61c"; : > "$L"
(cd "$T61/nogit/.claude/tasks/ABC-1/tmp" && TJ_CLI_LOG="$L" PATH="$TJSHIM:$PATH" \
  "$BASH_BIN" "$TJDIR/theme-json.sh" themes --engine themecli) >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 2 ] && grep -q 'error=no_store' "$E" && [ ! -s "$L" ] \
   && grep -q "looked for $(cd "$T61/nogit/.claude/tasks/ABC-1/tmp" && pwd)/shopify.theme.toml" "$E" \
   && grep -q 'run from the project root or set TOML_PATH' "$E"; then ok
else bad T61c-no-git-unchanged "rc=$rc err=$(head -c 200 "$E" | tr '\n' ' ') log=$(tr '\n' ';' < "$L")"; fi
# T61d: in a git worktree whose `.claude/tasks` is a symlink into the MAIN checkout (base's worktree-setup.sh),
# `git rev-parse --show-toplevel` from there answers the MAIN checkout — the other store config. The
# walk is over the logical cwd, so it stays in the worktree.
mkdir -p "$T61/main/.claude/tasks/ABC-1/tmp" "$T61/wt/.claude"
git -C "$T61/main" init -q 2>/dev/null
printf '[environments.development]\nstore = "acme-main"\npassword = "shptka_fixture1234"\n' > "$T61/main/shopify.theme.toml"
printf '[environments.development]\nstore = "acme-wt"\npassword = "shptka_fixture1234"\n' > "$T61/wt/shopify.theme.toml"
printf 'gitdir: %s/main/.git/worktrees/wt\n' "$T61" > "$T61/wt/.git"
ln -s "$T61/main/.claude/tasks" "$T61/wt/.claude/tasks"
rc=0; L="$TMP/tjl61d"; : > "$L"
(cd "$T61/wt/.claude/tasks/ABC-1/tmp" && TJ_CLI_LOG="$L" PATH="$TJSHIM:$PATH" \
  "$BASH_BIN" "$TJDIR/theme-json.sh" themes --engine themecli) >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -q 'argv=.*--store acme-wt\.myshopify\.com ' "$L"; then ok
else bad T61d-worktree-stays-in-worktree "rc=$rc log=$(grep -v token "$L" | tr '\n' ';') err=$(head -c 160 "$E" | tr '\n' ' ')"; fi
# T61e/T61f: the Bash tool persists the PHYSICAL cwd, so `cd .claude/tasks/ABC-1` in that worktree
# lands in main's workspace — a walk from there reads main's toml, the other store. With linked
# worktrees under main/.git/worktrees the walk picks nothing and says why; without them it walks.
T61M="$(cd "$T61/main/.claude/tasks/ABC-1" && pwd -P)"
rc=0; L="$TMP/tjl61f"; : > "$L"
(cd "$T61M" && TJ_CLI_LOG="$L" PATH="$TJSHIM:$PATH" \
  "$BASH_BIN" "$TJDIR/theme-json.sh" themes --engine themecli) >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -q 'argv=.*--store acme-main\.myshopify\.com ' "$L" && ! grep -q toml_walk_skipped "$E"; then ok
else bad T61f-no-linked-worktrees-walks "rc=$rc log=$(grep -v token "$L" | tr '\n' ';') err=$(head -c 160 "$E" | tr '\n' ' ')"; fi
mkdir -p "$T61/main/.git/worktrees/wt"
rc=0; L="$TMP/tjl61e"; : > "$L"
(cd "$T61M" && TJ_CLI_LOG="$L" PATH="$TJSHIM:$PATH" \
  "$BASH_BIN" "$TJDIR/theme-json.sh" themes --engine themecli) >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 2 ] && grep -q 'error=no_store' "$E" && [ ! -s "$L" ] \
   && [ "$(grep -c '^note=toml_walk_skipped dir=' "$E")" -eq 1 ] && ! grep -q acme-main "$O" "$E"; then ok
else bad T61e-linked-worktrees-skip-walk "rc=$rc err=$(head -c 240 "$E" | tr '\n' ' ') log=$(tr '\n' ';' < "$L")"; fi
# T61g: the auto engine also runs the REAL gql runner, which inherits theme-json's pick — ONE note
T61G="$TMP/tj61g"; mkdir -p "$T61G"; cp "$TJ" "$COMMON" "$GQL" "$T61G/"
rc=0; L="$TMP/tjl61g"; : > "$L"
(cd "$T61M" && TJ_CLI_LOG="$L" PATH="$TJSHIM:$PATH" "$BASH_BIN" "$T61G/theme-json.sh" themes) >"$O" 2>"$E" || rc=$?
if [ "$rc" -ne 0 ] && [ "$(grep -c '^note=toml_walk_skipped dir=' "$E")" -eq 1 ] && ! grep -q acme-main "$O" "$E"; then ok
else bad T61g-auto-engine-one-note "rc=$rc err=$(head -c 320 "$E" | tr '\n' ' ')"; fi

# --- `set` read-back verify: Shopify keeps the PREVIOUS content for payloads it rejects
# server-side while the write reports success — push exit 0, no userErrors. Every case
# below drives that divergence through the stubs; the themecli set runs with --engine themecli so
# the gql stub is out of the picture. FE_THEME_JSON_VERIFY_WAIT=0 keeps every retrying case from
# paying the pause before the second read-back (2 s each at the default) — T47 is the one row
# that pays it, because it is the row about the fallback.
export FE_THEME_JSON_VERIFY_WAIT=0
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
# T35e: the verdict says WHAT differs — leaf key paths of the normalized pair on stderr, ahead of
# the hint, never a value and never the token
rc=0; SHOPIFY_CLI_THEME_TOKEN=shptka_verifydiff9876 TJ_PULL_BODY="$TV/old.json" PATH="$TJSHIM:$PATH" \
  "$BASH_BIN" "$TJDIR/theme-json.sh" set --engine themecli --store test.myshopify.com \
  --theme 2 --file templates/product.json --from "$TV/new.json" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 6 ] && [ "$(wc -l < "$O" | tr -d ' ')" -eq 1 ] \
   && grep -qx 'note=verify_diff only_in_payload=- only_in_theme=- changed=sections.main.settings.test_parent diff_lines=[0-9]*' "$E" \
   && [ "$(grep -n '^note=verify_diff' "$E" | cut -d: -f1)" -lt "$(grep -n '^hint=' "$E" | cut -d: -f1)" ] \
   && ! grep -q 'shptka_verifydiff9876' "$E" \
   && ! grep '^note=verify_diff' "$E" | grep -qe 'old' -e 'metafields'; then ok
else bad T35e-verify-diff-keys "rc=$rc out=$(head -c 160 "$O") err=$(grep -v shptka "$E" | head -c 300 | tr '\n' ' ')"; fi
# T35f: each key list caps at 8 plus a `+N_more` count — a whole settings_data.json that did not
# land must not flood the caller's context
printf '{"sections":{"main":{"settings":{%s}}}}' \
  "$(for i in 0 1 2 3 4 5 6 7 8 9 10 11; do printf '"k%02d":"v",' "$i"; done | sed 's/,$//')" > "$TV/many.json"
printf '%s' '{"sections":{"main":{"type":"main"}}}' > "$TV/few.json"
rc=0; TJ_PULL_BODY="$TV/few.json" tj_set_cli "$TV/many.json" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 6 ] \
   && grep -qx 'note=verify_diff only_in_payload=sections.main.settings.k00,sections.main.settings.k01,sections.main.settings.k02,sections.main.settings.k03,sections.main.settings.k04,sections.main.settings.k05,sections.main.settings.k06,sections.main.settings.k07,+4_more only_in_theme=sections.main.type changed=- diff_lines=[0-9]*' "$E"; then ok
else bad T35f-verify-diff-capped "rc=$rc err=$(head -c 400 "$E" | tr '\n' ' ')"; fi
# T35g: the payload's extra keys are the ONLY difference (a setting the section schema dropped) —
# the rest landed, so the hint names the dropped keys instead of claiming nothing is served; still
# not_applied + exit 6, since the theme diverged from the payload
printf '%s' '{"sections":{"main":{"type":"main","settings":{"a":"1","aspect_ratio":"square"}}}}' > "$TV/stale-key.json"
printf '%s' '{"sections":{"main":{"type":"main","settings":{"a":"1"}}}}' > "$TV/stale-key-served.json"
rc=0; TJ_PULL_BODY="$TV/stale-key-served.json" tj_set_cli "$TV/stale-key.json" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 6 ] && grep -q 'error=not_applied engine=themecli theme=2 file=templates/product.json' "$O" \
   && grep -qxF 'hint=applied except 1 key(s) Shopify dropped (sections.main.settings.aspect_ratio) — a setting the section schema no longer has, or an unsupported attribute; the rest of the payload is live. Remove them from the payload to make the write clean. If these keys ARE the change you meant to make, the whole write was refused instead — check the two known triggers: a schema-unsupported attribute, and a dynamic source without '\''{{ ….value }}'\''.' "$E" \
   && ! grep -q 'does NOT serve' "$E"; then ok
else bad T35g-dropped-keys-hint "rc=$rc err=$(head -c 400 "$E" | tr '\n' ' ')"; fi
# T35h: the count covers the keys folded into `+N_more`, not just the 8 listed
printf '%s' '{"sections":{"main":{"settings":{"k00":"v"}}}}' > "$TV/one.json"
rc=0; TJ_PULL_BODY="$TV/one.json" tj_set_cli "$TV/many.json" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 6 ] && grep -q '^hint=applied except 11 key(s) Shopify dropped (sections.main.settings.k01,.*,+3_more) — ' "$E"; then ok
else bad T35h-dropped-keys-count "rc=$rc err=$(head -c 400 "$E" | tr '\n' ' ')"; fi
# T35i: any other mix keeps the general hint — a theme-only key means the write did not simply drop
rc=0; TJ_PULL_BODY="$TV/few.json" tj_set_cli "$TV/many.json" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 6 ] && grep -q 'does NOT serve the payload' "$E" && ! grep -q 'applied except' "$E"; then ok
else bad T35i-mixed-diff-general-hint "rc=$rc err=$(head -c 400 "$E" | tr '\n' ' ')"; fi

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

# T38 (escape hatch): FE_THEME_JSON_VERIFY=0 does no read-back at all — the pull-back fixture is
# the stale content, which would otherwise fail the case, and no pull is recorded
rc=0; C38="$TMP/tj38-pulls"; : > "$C38"
FE_THEME_JSON_VERIFY=0 TJ_PULL_BODY="$TV/old.json" TJ_PULL_COUNT="$C38" \
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
# same read-back runs there (the stub's FeThemeFileGet answers with FAKE_BODY_FILE)
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
if grep -q '^note=verify_diff .*changed=sections.main.settings.test_parent diff_lines=' "$E"; then ok
else bad T41b-gql-verify-diff "err=$(head -c 300 "$E" | tr '\n' ' ')"; fi

# T42 (degradation): the normalizer needs perl to strip the banner, and the `set` json guard
# already degrades instead of refusing when perl is missing — the verify does the same, comparing
# raw bytes and saying so on stderr.
NOPERL="$TMP/noperl-bin"
path_without "$NOPERL" perl \
  jq mktemp cmp cat sed tr wc grep awk dirname mkdir head tail cp sleep rm touch bash
rc=0; SHOPIFY_CLI_THEME_TOKEN=fake TJ_PULL_BODY="$TV/new.json" PATH="$TJSHIM:$NOPERL" \
  "$BASH_BIN" "$TJDIR/theme-json.sh" set --engine themecli --store test.myshopify.com \
  --theme 2 --file templates/product.json --from "$TV/new.json" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -q '"verified":"true"' "$O" && grep -q 'note=verify_raw_compare' "$E"; then ok
else bad T42-no-perl-raw-compare "rc=$rc out=$(head -c 160 "$O") err=$(head -c 200 "$E" | tr '\n' ' ')"; fi

# T43 (bug): the degradation above must not be fail-CLOSED. Shopify re-stamps the banner and
# reserializes on EVERY successful write, so on a perl-less host the raw compare differs for
# every real `set` — reporting that as not_applied + exit 6 would make the escape hatch
# (FE_THEME_JSON_VERIFY=0) the only way to work, restoring the very false success this exists
# to kill. A raw MISMATCH is `verified=unverified` + exit 0 instead, said on stderr.
rc=0; SHOPIFY_CLI_THEME_TOKEN=fake TJ_PULL_BODY="$TV/reserialized.json" PATH="$TJSHIM:$NOPERL" \
  "$BASH_BIN" "$TJDIR/theme-json.sh" set --engine themecli --store test.myshopify.com \
  --theme 2 --file templates/product.json --from "$TV/payload.json" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -q '"ok":"upserted"' "$O" && grep -q '"verified":"unverified"' "$O" \
   && grep -q 'note=verify_unverified' "$E" && ! grep -q 'error=not_applied' "$O"; then ok
else bad T43-no-perl-mismatch-fails-open "rc=$rc out=$(head -c 200 "$O") err=$(head -c 240 "$E" | tr '\n' ' ')"; fi
# T43b: an unverified verdict is not a mismatch, so it carries no diff to judge by
if ! grep -q 'note=verify_diff' "$E"; then ok
else bad T43b-unverified-no-diff "err=$(head -c 240 "$E" | tr '\n' ' ')"; fi

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
if grep -qx 'note=verify_diff diff_lines=[0-9][0-9]*' "$E" && ! grep -q 'Shopify was unhappy' "$E"; then ok
else bad T47e-body-not-json-diff-count "err=$(head -c 240 "$E" | tr '\n' ' ')"; fi
# T47b (bug): and that verdict is per ATTEMPT. The flag was sticky for the whole run, so one
# garbled first read poisoned a clean, MATCHING second one into `unverified`.
rc=0; C47="$TMP/tj47-pulls"; : > "$C47"
TJ_PUSH_SAVE="$TV/pushed47.json" TJ_PULL_BODY_1="$TV/garbled.json" TJ_PULL_BODY="$TV/pushed47.json" \
  TJ_PULL_COUNT="$C47" tj_set_cli "$TV/new.json" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -q '"verified":"true"' "$O" && [ "$(cat "$C47")" = 2 ]; then ok
else bad T47b-garbled-then-clean "rc=$rc pulls=$(cat "$C47") out=$(head -c 200 "$O") err=$(head -c 240 "$E" | tr '\n' ' ')"; fi
# T47c: an unusable FE_THEME_JSON_VERIFY_WAIT falls back to the default instead of handing
# `sleep` an argument it refuses — under `set -e` that would abort the verify mid-run. This is
# the one row in the section that pays the pause.
rc=0; FE_THEME_JSON_VERIFY_WAIT=soon TJ_PULL_BODY="$TV/old.json" tj_set_cli "$TV/new.json" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 6 ] && grep -q 'error=not_applied' "$O" && ! grep -qi 'sleep' "$E"; then ok
else bad T47c-invalid-wait "rc=$rc out=$(head -c 200 "$O") err=$(head -c 240 "$E" | tr '\n' ' ')"; fi
# T47d: `1.2.3` is the shape a bytes-only filter lets through — `sleep` still refuses it, and under
# `set -e` that aborted the verify AFTER the mutation had committed, stranding the caller with no
# verdict at all. It must fall back like any other unusable value.
rc=0; FE_THEME_JSON_VERIFY_WAIT=1.2.3 TJ_PULL_BODY="$TV/old.json" tj_set_cli "$TV/new.json" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 6 ] && grep -q 'error=not_applied' "$O" && ! grep -qi 'sleep' "$E"; then ok
else bad T47d-multidot-wait "rc=$rc out=$(head -c 200 "$O") err=$(head -c 240 "$E" | tr '\n' ' ')"; fi
# T47e: theme-json.sh itself fills its switches from the domaine env files, not just the reader
# (EV4 proves the reader). A `sleep` shim records the pause the retry asks for: the project
# layer's FE_THEME_JSON_VERIFY_WAIT reaches it, and a project-layer FE_THEME_JSON_VERIFY=0 does
# not (verify gates are global-file-only) — the global file's does.
TJE="$TMP/tj47e"; mkdir -p "$TJE/proj/.claude" "$TJE/proj/sub" "$TJE/shim" "$TJE/xdg/domaine"
printf '#!/bin/sh\necho "$1" >> "%s"\n' "$TJE/sleeps" > "$TJE/shim/sleep"; chmod +x "$TJE/shim/sleep"
printf 'FE_THEME_JSON_VERIFY_WAIT = 0.5\nFE_THEME_JSON_VERIFY=0\n' > "$TJE/proj/.claude/domaine.env"
rc=0; : > "$TJE/sleeps"; C47e="$TMP/tj47e-pulls"; : > "$C47e"
( unset FE_THEME_JSON_VERIFY_WAIT FE_THEME_JSON_VERIFY; cd "$TJE/proj/sub" \
  && PATH="$TJE/shim:$PATH" TJ_PULL_BODY="$TV/old.json" TJ_PULL_COUNT="$C47e" \
     tj_set_cli "$TV/new.json" ) >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 6 ] && grep -q 'error=not_applied' "$O" && [ "$(cat "$TJE/sleeps")" = "0.5" ] \
   && [ "$(cat "$C47e")" = 2 ]; then ok
else bad T47e-project-env-wait "rc=$rc sleeps=$(tr '\n' ';' < "$TJE/sleeps") pulls=$(cat "$C47e") out=$(head -c 200 "$O")"; fi
printf 'FE_THEME_JSON_VERIFY=0\n' > "$TJE/xdg/domaine/env"
rc=0; : > "$C47e"
( unset FE_THEME_JSON_VERIFY_WAIT FE_THEME_JSON_VERIFY; cd "$TJE/proj/sub" \
  && XDG_CONFIG_HOME="$TJE/xdg" PATH="$TJE/shim:$PATH" TJ_PULL_BODY="$TV/old.json" TJ_PULL_COUNT="$C47e" \
     tj_set_cli "$TV/new.json" ) >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -q '"verified":"skipped"' "$O" && [ ! -s "$C47e" ]; then ok
else bad T47f-global-env-verify-off "rc=$rc pulls=$(cat "$C47e") out=$(head -c 200 "$O")"; fi
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
# T50c2: the same listing spelled in the gid dialect is the SAME theme — the matcher these guards
# share compares the numeric tail, so a store whose `theme list --json` answers in gids does not
# read as a store with no themes at all
rc=0; L="$TMP/tjl50c2"; : > "$L"
TJ_CLI_LOG="$L" TJ_PUSH_SAVE="$TV/pushed50c2.json" TJ_PULL_BODY="$TV/pushed50c2.json" \
  TJ_LIST_JSON='[{"id":"gid://shopify/OnlineStoreTheme/2","name":"Dev","role":"development"}]' \
  tj_set_cli "$TV/new.json" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && ! grep -q 'theme_not_found' "$E" && grep -q 'argv=theme push' "$L"; then ok
else bad T50c2-cli-set-gid-listing "rc=$rc out=$(head -c 160 "$O") err=$(head -c 160 "$E" | tr '\n' ' ')"; fi
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

# --- themecli failure diagnostics: every cli_*_failed line names the store and the credential's
# origin; an auth rejection (the CLI's box-drawing "401 undefined") also names the per-store
# mismatch, since a Theme Access token is minted PER STORE.
# T53: the toml-token variant — the error line carries both facts and the hint names the mismatch
rc=0; TOML_PATH="$TT/single.toml" TJ_LIST_FAIL=401 PATH="$TJSHIM:$PATH" \
  "$BASH_BIN" "$TJDIR/theme-json.sh" themes --engine themecli >"$O" 2>"$E" || rc=$?
assert T53-list-401-error-line 5 "$rc" "$E" "error=cli_list_failed store=acme-dev.myshopify.com token_source=toml"
if grep -q '^hint=.*PER STORE' "$E" && grep -q "$TT/single.toml" "$E" \
   && grep -q 'acme-dev.myshopify.com' "$E" && grep -q '401 undefined' "$E"; then ok
else bad T53b-list-401-hint "err=$(tr '\n' ';' < "$E" | head -c 400)"; fi
# T53d: store and token both out of the toml — the remedy is that toml's password=, not TOML_PATH
if grep -q 'password= in .*single.toml is not acme-dev.myshopify.com' "$E" && ! grep -q 'TOML_PATH' "$E"; then ok
else bad T53d-list-401-toml-remedy "err=$(grep '^hint=' "$E" | head -c 400)"; fi
# T53c: verdict → fix → the CLI's own words; the raw tail is noise until the first two have run
if [ "$(grep -n 'error=cli_list_failed' "$E" | head -1 | cut -d: -f1)" -lt "$(grep -n '^hint=' "$E" | head -1 | cut -d: -f1)" ] \
   && [ "$(grep -n '^hint=' "$E" | head -1 | cut -d: -f1)" -lt "$(grep -n '401 undefined' "$E" | head -1 | cut -d: -f1)" ]; then ok
else bad T53c-list-401-order "err=$(tr '\n' ';' < "$E" | head -c 400)"; fi

# T54: any other failure keeps the shape but must NOT claim an auth mismatch — a hint that names
# the wrong cause is worse than none
rc=0; TOML_PATH="$TT/single.toml" TJ_LIST_FAIL=other PATH="$TJSHIM:$PATH" \
  "$BASH_BIN" "$TJDIR/theme-json.sh" themes --engine themecli >"$O" 2>"$E" || rc=$?
assert T54-list-other-error-line 5 "$rc" "$E" "error=cli_list_failed store=acme-dev.myshopify.com token_source=toml"
if ! grep -q '^hint=' "$E" && grep -q 'ENOTFOUND' "$E"; then ok
else bad T54b-list-other-no-hint "err=$(tr '\n' ';' < "$E" | head -c 300)"; fi

# T54c: `401` inside a request id is not a status code — the same silence as any other failure
rc=0; TOML_PATH="$TT/single.toml" TJ_LIST_FAIL=reqid PATH="$TJSHIM:$PATH" \
  "$BASH_BIN" "$TJDIR/theme-json.sh" themes --engine themecli >"$O" 2>"$E" || rc=$?
assert T54c-list-reqid-error-line 5 "$rc" "$E" "error=cli_list_failed store=acme-dev.myshopify.com token_source=toml"
if ! grep -q '^hint=' "$E" && grep -q '7d401ef2' "$E"; then ok
else bad T54d-list-reqid-no-hint "err=$(tr '\n' ';' < "$E" | head -c 300)"; fi

# T54e: a timestamp `.401 ` or a dashed id `-401-` is not a status code either
rc=0; TOML_PATH="$TT/single.toml" TJ_LIST_FAIL=ts PATH="$TJSHIM:$PATH" \
  "$BASH_BIN" "$TJDIR/theme-json.sh" themes --engine themecli >"$O" 2>"$E" || rc=$?
assert T54e-list-ts-error-line 5 "$rc" "$E" "error=cli_list_failed store=acme-dev.myshopify.com token_source=toml"
if ! grep -q '^hint=' "$E" && grep -q 'ab-401-cd' "$E"; then ok
else bad T54f-list-ts-no-hint "err=$(tr '\n' ';' < "$E" | head -c 300)"; fi

# T55: the env-token variant — the hint has to send the reader to the variable, not to a toml
rc=0; SHOPIFY_CLI_THEME_TOKEN=fake TJ_LIST_FAIL=401 PATH="$TJSHIM:$PATH" \
  "$BASH_BIN" "$TJDIR/theme-json.sh" themes --engine themecli --store test.myshopify.com >"$O" 2>"$E" || rc=$?
assert T55-list-401-env-token 5 "$rc" "$E" "error=cli_list_failed store=test.myshopify.com token_source=env"
if grep -qF 'came from $SHOPIFY_CLI_THEME_TOKEN' "$E" && ! grep -q 'came from .*\.toml' "$E"; then ok
else bad T55b-list-401-env-hint "err=$(tr '\n' ';' < "$E" | head -c 300)"; fi
# T55c: with --store overriding the toml the remedy is a token for THAT store, TOML_PATH included
if grep -q 'TOML_PATH pointing at a toml whose store= is test.myshopify.com' "$E"; then ok
else bad T55c-list-401-override-remedy "err=$(grep '^hint=' "$E" | head -c 400)"; fi

# T59: the same rejection through get's pull and set's push carries the same two facts and the
# same hint, in the same order, and still exits 5 — the hint helper must never eat the exit
rc=0; TOML_PATH="$TT/single.toml" TJ_PULL_FAIL=401 PATH="$TJSHIM:$PATH" \
  "$BASH_BIN" "$TJDIR/theme-json.sh" get --engine themecli --theme 2 --file templates/product.json >"$O" 2>"$E" || rc=$?
assert T59-pull-401-error-line 5 "$rc" "$E" "error=cli_pull_failed theme=2 store=acme-dev.myshopify.com token_source=toml"
if grep -q '^hint=.*PER STORE' "$E" \
   && [ "$(grep -n '^hint=' "$E" | head -1 | cut -d: -f1)" -lt "$(grep -n '401 undefined' "$E" | head -1 | cut -d: -f1)" ]; then ok
else bad T59b-pull-401-hint "err=$(tr '\n' ';' < "$E" | head -c 400)"; fi
rc=0; TOML_PATH="$TT/single.toml" TJ_PUSH_FAIL=401 PATH="$TJSHIM:$PATH" \
  "$BASH_BIN" "$TJDIR/theme-json.sh" set --engine themecli --theme 2 --file templates/product.json \
  --from "$TMP/snap.json" >"$O" 2>"$E" || rc=$?
assert T59c-push-401-error-line 5 "$rc" "$E" "error=cli_push_failed theme=2 store=acme-dev.myshopify.com token_source=toml"
if grep -q '^hint=.*PER STORE' "$E" && grep -q '401 undefined' "$E"; then ok
else bad T59d-push-401-hint "err=$(tr '\n' ';' < "$E" | head -c 400)"; fi
# T59e: a pull that fails for any other reason names the facts and stays silent on auth
rc=0; TOML_PATH="$TT/single.toml" TJ_PULL_FAIL=1 PATH="$TJSHIM:$PATH" \
  "$BASH_BIN" "$TJDIR/theme-json.sh" get --engine themecli --theme 2 --file templates/product.json >"$O" 2>"$E" || rc=$?
assert T59e-pull-503-error-line 5 "$rc" "$E" "error=cli_pull_failed theme=2 store=acme-dev.myshopify.com token_source=toml"
if ! grep -q '^hint=' "$E"; then ok; else bad T59f-pull-503-no-hint "err=$(tr '\n' ';' < "$E" | head -c 300)"; fi

unset FE_THEME_JSON_VERIFY_WAIT

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
# refusal — an empty TJ_GQL_LOG is that assertion.
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

# T52: --env and --api-version do nothing in this script beyond reaching the runner — arriving in
# any other spelling silently drops the caller's non-default env file or API version
TJA="$TMP/tj-argv"; : > "$TJA"
rc=0; TJ_GQL_LOG="$TJA" "$BASH_BIN" "$TJDIR/theme-json.sh" get --theme 2 --file templates/product.json \
  --store test.myshopify.com --env alt.env --api-version 2099-01 >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -q -- '--env alt.env' "$TJA" && grep -q -- '--api-version 2099-01' "$TJA"; then ok
else bad T52-runner-flags-forwarded "rc=$rc argv=$(tr '\n' ';' < "$TJA") err=$(head -c 160 "$E" | tr '\n' ' ')"; fi
# T52b: and each takes a value, so as the last arg it hits need_val before the runner is reached
for tf in --env --api-version; do
  rc=0; : > "$TJA"; TJ_GQL_LOG="$TJA" "$BASH_BIN" "$TJDIR/theme-json.sh" get --theme 2 "$tf" >"$O" 2>"$E" || rc=$?
  assert "T52b-need-val[$tf]" 2 "$rc" "$E" "error=missing_value flag=$tf"
  if [ ! -s "$TJA" ]; then ok; else bad "T52b-no-engine[$tf]" "the runner ran before the usage error"; fi
done

# --- --help: `--help` / `-h` answers the call shape without a store, a runner or a parse — bare,
# after a command, and among a command's args ---------------------------------------------------
for ha in --help -h; do
  rc=0; "$BASH_BIN" "$TJDIR/theme-json.sh" "$ha" >"$O" 2>"$E" || rc=$?
  if [ "$rc" -eq 0 ] && grep -q 'theme-json.sh get  --theme' "$O" && [ ! -s "$E" ]; then ok
  else bad "T56-help[$ha]" "rc=$rc out=$(head -c 120 "$O") err=$(head -c 120 "$E" | tr '\n' ' ')"; fi
done
# T56b: …and after a command too, which is where a model reaches for it
for hc in "get --help" "set -h" "themes --help"; do
  rc=0; "$BASH_BIN" "$TJDIR/theme-json.sh" $hc >"$O" 2>"$E" || rc=$?
  if [ "$rc" -eq 0 ] && grep -q 'theme-json.sh get  --theme' "$O"; then ok
  else bad "T56b-help[$hc]" "rc=$rc out=$(head -c 120 "$O") err=$(head -c 120 "$E" | tr '\n' ' ')"; fi
done
# T56c: --help among a command's other args is still a usage question — no store is ever touched
rc=0; : > "$TJA"; TJ_GQL_LOG="$TJA" "$BASH_BIN" "$TJDIR/theme-json.sh" get --theme 2 \
  --file templates/product.json --help >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -q 'theme-json.sh get  --theme' "$O" && [ ! -s "$TJA" ]; then ok
else bad T56c-help-mid-args "rc=$rc argv=$(tr '\n' ';' < "$TJA") out=$(head -c 120 "$O")"; fi

# T57 (drift guard): --help prints the header's own `# Usage:` block. Two hand-maintained copies
# of a call shape are two copies free to disagree, and the header is the one a reader lands on.
TJH="$TMP/tj-usage-header"
awk '/^# Usage:/ { f = 1 } f { if ($0 == "#" || $0 !~ /^#( |$)/) exit; sub(/^# ?/, ""); print }' \
  "$TJ" > "$TJH"
rc=0; "$BASH_BIN" "$TJDIR/theme-json.sh" --help >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ "$(wc -l < "$TJH" | tr -d ' ')" -eq 6 ] && sed '$d' "$O" | diff -q - "$TJH" >/dev/null; then ok
else bad T57-help-matches-header "rc=$rc diff=$(sed '$d' "$O" | diff - "$TJH" | head -c 300 | tr '\n' ';')"; fi
# T57b: the pointer line that follows it names where the full contract lives
if [ "$(tail -1 "$O")" = "Full contract: the header of $TJDIR/theme-json.sh" ]; then ok
else bad T57b-help-pointer "tail=$(tail -1 "$O")"; fi
# T57c: the reference's copy of the three command lines is the same text (the third copy)
TJR="$ROOT/plugins/fe/references/theme-customizer-state.md"
if [ "$(grep -c '^theme-json.sh \(themes\|get\|set\) ' "$TJR")" -eq 3 ] \
   && grep '^theme-json.sh \(themes\|get\|set\) ' "$TJR" | diff -q - <(grep '^  theme-json.sh ' "$TJH" | sed 's/^  //') >/dev/null; then ok
else bad T57c-reference-matches-usage "diff=$(grep '^theme-json.sh ' "$TJR" | diff - <(sed 's/^  //' "$TJH" | grep '^theme-json.sh ') | head -c 300 | tr '\n' ';')"; fi
# T57d: the unknown_arg trailer lists every flag the parser accepts — a `--foo)` arm added above
# without a trailer update would leave the refusal lying about the accepted set
TJF="$(awk '/^while \[ \$# -gt 0 \]; do/ { f = 1 } f && /^done/ { exit } f && match($0, /^ *--[a-z-]+\)/) { s = substr($0, RSTART, RLENGTH); sub(/^ */, "", s); sub(/\)$/, "", s); print s }' "$TJ")"
rc=0; "$BASH_BIN" "$TJDIR/theme-json.sh" get --bogus >"$O" 2>"$E" || rc=$?
missing=""; n=0
for fl in $TJF; do n=$((n + 1)); grep -q -- "flags:.* $fl\( \|;\)" "$E" || missing="$missing $fl"; done
if [ "$n" -ge 10 ] && [ -z "$missing" ]; then ok; else bad T57d-trailer-lists-flags "n=$n missing=[$missing] err=$(head -c 200 "$E")"; fi

# T58: the refusals name the way out — a guessed flag has to self-correct in one step
rc=0; "$BASH_BIN" "$TJDIR/theme-json.sh" bogus >"$O" 2>"$E" || rc=$?
assert T58-unknown-command-trailer 2 "$rc" "$E" "error=unknown_command cmd='bogus' (use themes|get|set; --help prints usage)"
rc=0; "$BASH_BIN" "$TJDIR/theme-json.sh" get --key sections >"$O" 2>"$E" || rc=$?
assert T58b-unknown-arg-trailer 2 "$rc" "$E" "error=unknown_arg arg=--key (flags: --theme --file"
if grep -q -- '--file' "$E" && grep -q -- '--help prints usage' "$E"; then ok
else bad T58c-unknown-arg-names-flags "err=$(head -c 200 "$E" | tr '\n' ' ')"; fi
# T58d: a positional path takes the same one-line correction
rc=0; "$BASH_BIN" "$TJDIR/theme-json.sh" get --theme 2 templates/product.json >"$O" 2>"$E" || rc=$?
assert T58d-positional-refused 2 "$rc" "$E" "error=unknown_arg arg=templates/product.json (flags: --theme --file"

# ------------------------------------- shopify-admin-gql.sh against PATH shims --
SHIM="$TMP/shim"; mkdir -p "$SHIM"
GQLDIR="$TMP/gqlwork"; mkdir -p "$GQLDIR"
printf 'mutation FeX { thingCreate { id } }\n' > "$GQLDIR/mutation.graphql"
printf 'query FeY { shop { name } }\n' > "$GQLDIR/query.graphql"
printf '{"k":"v"}\n' > "$GQLDIR/vars.json"
# a multi-operation document: --operation must carve out ONE named block plus every fragment
printf 'query FeA {\n  shop { ...F }\n}\n\nmutation FeB {\n  thingCreate { id }\n}\n\nfragment F on Shop {\n  name\n}\n' > "$GQLDIR/multi.graphql"
# two operations on ONE line — a declaration reader anchored to the start of a line sees neither
printf 'query FeOne { shop { name } } query FeTwo { shop { id } }\n' > "$GQLDIR/oneline.graphql"
# a signature split across lines, and braces hiding inside a "string" and a # comment
printf 'query\n  FeSig($id: ID!) {\n  node(id: $id) { id }\n}\n' > "$GQLDIR/sig.graphql"
printf 'query FeNoisy {\n  shop(k: "a } b") { name }\n  # a } in a comment\n  localization { country { isoCode } }\n  ...FeG\n}\n\nfragment FeG on Shop {\n  name\n}\n' > "$GQLDIR/noisy.graphql"
# a """ block string is outside what the reader blanks out — the document is refused, not guessed at
printf 'query FeBlock($d: String = """x""") {\n  shop { name }\n}\n' > "$GQLDIR/block.graphql"
# a directive between the operation name and its selection set
printf 'query FeDir @someDirective {\n  shop { name }\n}\n\nquery FePlain {\n  shop { id }\n}\n' > "$GQLDIR/directive.graphql"
# a """ written inside a # comment is text — blanking comments is what the sanitizer is for
printf 'query FeHash {\n  # a """ here is prose, not a block string\n  shop { name }\n}\n\nquery FeOther {\n  shop { id }\n}\n' > "$GQLDIR/hashquotes.graphql"
# ONE operation carrying a real block string: nothing to narrow, so nothing to refuse
printf 'mutation FeSeed($x: String = """seed""") {\n  thingCreate { id }\n}\n' > "$GQLDIR/blockmut.graphql"
# a top-level token the reader does not know (schema SDL in a document meant to be executed)
printf 'type FeThing {\n  a: Int\n}\n\nquery FeSchema {\n  shop { name }\n}\n' > "$GQLDIR/schema.graphql"
# a UTF-8 BOM ahead of the first keyword — a multibyte-locale awk aborts on it mid-parse
printf '\357\273\277query FeBom {\n  shop { name }\n}\n' > "$GQLDIR/bom.graphql"
# a query and a mutation on ONE line — the hazard read is line-anchored no more
printf 'query FeML { shop { name } } mutation FeMM { thingCreate { id } }\n' > "$GQLDIR/onelinemix.graphql"

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
  # a CLI that prints the FULL envelope instead of today's bare data — the runner's wrap must
  # recognize it rather than nest it one level deeper
  ok-envelope) echo '{"data":{"ok":true}}'; exit 0 ;;
  ok-errors)   echo '{"errors":[{"message":"Field x does not exist"}]}'; exit 0 ;;
esac
FAKE
cat > "$SHIM/curl" <<'FAKE'
#!/usr/bin/env bash
# emulates the exact flags the runner uses: -o <file>, -w '%{http_code}', --data @file, -K <cfg>
touch "${CURL_MARKER:-/dev/null}"
# CURL_ARGV records the argv as handed over — the transport timeouts live nowhere else.
# FAKE_CURL_RC is a transport failure (28 = --max-time expired), which produces no response file.
[ -n "${CURL_ARGV:-}" ] && printf '%s\n' "$*" >> "$CURL_ARGV"
[ -n "${FAKE_CURL_RC:-}" ] && exit "$FAKE_CURL_RC"
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
gql_state() { printf '%s/fe-gql-%s' "$1" "$(id -u)"; }   # the runner's per-user state dir

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

# G24: FE_GQL_PROBE_CACHE=0 is the escape hatch — warm state is ignored, everything is re-probed
QT9="$TMP/probe-off"; mkdir -p "$QT9"
rc=0; GQL_TMPDIR="$QT9" run_gql --query query.graphql >"$O" 2>"$E" || rc=$?
L6="$TMP/sl6"; : > "$L6"
rc=0; GQL_TMPDIR="$QT9" GQL_LOG="$L6" FE_GQL_PROBE_CACHE=0 \
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

# G48 (bug): the runner's toml read is block-scoped too — a file-ordered `store=` sent the query to
# whichever environment happened to be listed first, which in a real config is production
TD48="$TMP/gqltoml48"; mkdir -p "$TD48"; cp "$GQLDIR/query.graphql" "$TD48/"
printf '[environments.production]\nstore = "store-a"\n\n[environments.dev]\nstore = "store-b"\n' > "$TD48/shopify.theme.toml"
rc=0; FAKE_HTTP=401 gql_run_at "$TD48" --engine token --query query.graphql >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 5 ] && grep -q 'url=https://store-b.myshopify.com/admin/' "$E"; then ok
else bad G48-toml-block-store "rc=$rc err=$(head -c 160 "$E" | tr '\n' ' ')"; fi
rc=0; FAKE_HTTP=401 SHOPIFY_FLAG_ENVIRONMENT=production \
  gql_run_at "$TD48" --engine token --query query.graphql >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 5 ] && grep -q 'url=https://store-a.myshopify.com/admin/' "$E"; then ok
else bad G48b-flag-environment "rc=$rc err=$(head -c 160 "$E" | tr '\n' ' ')"; fi

# G48c (blocker): different stores, none of the blocks named dev/development — refused before the
# request, since neither answer can be shown to be the one the developer meant
TD48C="$TMP/gqltoml48c"; mkdir -p "$TD48C"; cp "$GQLDIR/query.graphql" "$TD48C/"
printf '[environments.production]\nstore = "store-a"\n\n[environments.staging]\nstore = "store-c"\n' > "$TD48C/shopify.theme.toml"
rc=0; M="$TMP/m48c"; rm -f "$M"; CURL_MARKER="$M" \
  gql_run_at "$TD48C" --engine token --query query.graphql >"$O" 2>"$E" || rc=$?
assert G48c-gql-ambiguous-env 2 "$rc" "$E" "error=ambiguous_env envs=production staging"
if [ ! -f "$M" ]; then ok; else bad G48d-gql-ambiguous-no-request "a query went out on a guessed store"; fi
# G48e: --store is the escape hatch the message names — the toml is not consulted at all then
rc=0; gql_run_at "$TD48C" --engine token --store store-c --query query.graphql >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -q '"ok":true' "$O"; then ok
else bad G48e-store-flag-bypasses-toml "rc=$rc err=$(head -c 160 "$E" | tr '\n' ' ')"; fi

# G50 (bug): the runner's own toml lookup is the shared walk too — theme-json's gql engine calls it
# from the same persisted cwd, so from `.claude/tasks/<id>/tmp` it has to reach the checkout's toml
TD50="$TMP/gqltoml50"; mkdir -p "$TD50/.claude/tasks/ABC-1/tmp"; git -C "$TD50" init -q 2>/dev/null
cp "$GQLDIR/query.graphql" "$TD50/.claude/tasks/ABC-1/tmp/"
printf '[environments.development]\nstore = "acme-root"\n' > "$TD50/shopify.theme.toml"
rc=0; FAKE_HTTP=401 gql_run_at "$TD50/.claude/tasks/ABC-1/tmp" --engine token --query query.graphql >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 5 ] && grep -q 'url=https://acme-root.myshopify.com/admin/' "$E"; then ok
else bad G50-toml-from-task-subdir "rc=$rc err=$(head -c 160 "$E" | tr '\n' ' ')"; fi

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
# the full note printed once long ago, and without the suffix FE_GQL_PROBE_CACHE=0 is unreachable
QT22="$TMP/probe-shortnote"; mkdir -p "$QT22"
rc=0; GQL_TMPDIR="$QT22" FAKE_EXEC_MODE=noauth run_gql --query query.graphql >"$O" 2>"$E" || rc=$?
rc2=0; GQL_TMPDIR="$QT22" run_gql --query query.graphql >"$O" 2>"$TMP/e41" || rc2=$?
if [ "$rc" -eq 0 ] && [ "$rc2" -eq 0 ] \
   && grep -q 'note=engine=token (store-skip cached — FE_GQL_PROBE_CACHE=0 re-probes)' "$TMP/e41"; then ok
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
  run_gql --query multi.graphql --operation FeA >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -q '"data":{"ok":true}' "$O" \
   && [ "$(grep -c 'store execute' "$L43")" -eq 1 ] && ! grep -q -- '--allow-mutations' "$L43" \
   && grep -q '^query FeA' "$QF43" && grep -q '^fragment F on Shop' "$QF43" \
   && ! grep -q 'FeB' "$QF43" && ! grep -q 'mutation' "$QF43"; then ok
else bad G43-operation-extracted "rc=$rc out=$(head -c 80 "$O") log=$(tr '\n' ';' < "$L43") qf=$(tr '\n' ';' < "$QF43" 2>&1)"; fi
# G43b: a name the document does not define — the store engine steps aside with the reason and
# the token engine gets the WHOLE document (the Admin API takes operationName; the runner does not
# pass one, so the caller sees the same document the file holds)
L43b="$TMP/sl43b"; : > "$L43b"
rc=0; M="$TMP/m43b"; GQL_LOG="$L43b" CURL_MARKER="$M" FAKE_EXEC_MODE=ok \
  run_gql --query multi.graphql --operation Nope >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -q '"ok":true' "$O" && [ -f "$M" ] && ! grep -q 'store execute' "$L43b" \
   && grep -q "cannot isolate operation 'Nope'" "$E"; then ok
else bad G43b-operation-missing-falls-back "rc=$rc out=$(head -c 80 "$O") err=$(head -c 200 "$E" | tr '\n' ' ') log=$(tr '\n' ';' < "$L43b")"; fi
# G43c: the mutation block from the same document does get --allow-mutations (the detection
# runs on the EXTRACTED file, not the source document)
L43c="$TMP/sl43c"; : > "$L43c"
rc=0; GQL_LOG="$L43c" FAKE_EXEC_MODE=ok run_gql --query multi.graphql --operation FeB >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -q '"data":{"ok":true}' "$O" && grep -q 'store execute.*--allow-mutations' "$L43c"; then ok
else bad G43c-operation-mutation-flag "rc=$rc out=$(head -c 80 "$O") log=$(tr '\n' ';' < "$L43c")"; fi

# G43d (bug): two operations on ONE line. The reader only recognized a declaration at the start of
# a line, so --operation matched neither and the WHOLE document — both operations — went to the
# store engine. The narrowed text now holds exactly the named one.
L43d="$TMP/sl43d"; : > "$L43d"; QF43D="$TMP/qf43d.graphql"; rm -f "$QF43D"
rc=0; GQL_LOG="$L43d" SHOPIFY_QF_SAVE="$QF43D" FAKE_EXEC_MODE=ok \
  run_gql --query oneline.graphql --operation FeOne >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ "$(grep -c 'store execute' "$L43d")" -eq 1 ] \
   && [ "$(tr -d ' \n' < "$QF43D" 2>/dev/null)" = 'queryFeOne{shop{name}}' ]; then ok
else bad G43d-one-line-two-ops "rc=$rc qf=$(tr '\n' ';' < "$QF43D" 2>&1) log=$(tr '\n' ';' < "$L43d")"; fi
# G43e: the token engine is the one that CAN name an operation — it sends the whole document plus
# operationName, which is exactly why the store engine may step aside instead of guessing
rc=0; M="$TMP/m43e"; CURL_MARKER="$M" \
  run_gql --engine token --query oneline.graphql --operation FeOne >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -q '"operationName":"FeOne"' "$M.body"; then ok
else bad G43e-token-operation-name "rc=$rc body=$(head -c 200 "$M.body" 2>/dev/null)"; fi
# G43f: a declaration whose name sits on the next line is still one declaration
L43f="$TMP/sl43f"; : > "$L43f"; QF43F="$TMP/qf43f.graphql"; rm -f "$QF43F"
rc=0; GQL_LOG="$L43f" SHOPIFY_QF_SAVE="$QF43F" FAKE_EXEC_MODE=ok \
  run_gql --query sig.graphql --operation FeSig >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ "$(grep -c 'store execute' "$L43f")" -eq 1 ] \
   && [ "$(tr -d ' \n' < "$QF43F" 2>/dev/null)" = 'queryFeSig($id:ID!){node(id:$id){id}}' ]; then ok
else bad G43f-multiline-signature "rc=$rc qf=$(tr '\n' ';' < "$QF43F" 2>&1) log=$(tr '\n' ';' < "$L43f")"; fi
# G43g (bug): a } inside a "string" and a } inside a # comment moved the brace counter, so the
# extracted operation was cut off at the first of them — everything after it silently dropped,
# fragment included
QF43G="$TMP/qf43g.graphql"; rm -f "$QF43G"
rc=0; SHOPIFY_QF_SAVE="$QF43G" FAKE_EXEC_MODE=ok \
  run_gql --query noisy.graphql --operation FeNoisy >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -q 'localization' "$QF43G" && grep -q '\.\.\.FeG' "$QF43G" \
   && grep -q '^fragment FeG on Shop' "$QF43G"; then ok
else bad G43g-braces-in-string-and-comment "rc=$rc qf=$(tr '\n' ';' < "$QF43G" 2>&1)"; fi
# G43h: several operations and NO --operation — the store engine cannot pick one, and sending the
# document whole would run every operation in it, so it steps aside before anything is sent
L43h="$TMP/sl43h"; : > "$L43h"
rc=0; M="$TMP/m43h"; GQL_LOG="$L43h" CURL_MARKER="$M" FAKE_EXEC_MODE=ok \
  run_gql --query multi.graphql >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -q '"ok":true' "$O" && [ -f "$M" ] && ! grep -q 'store execute' "$L43h" \
   && grep -q '2 operations found' "$E"; then ok
else bad G43h-multi-op-no-operation "rc=$rc err=$(head -c 200 "$E" | tr '\n' ' ') log=$(tr '\n' ';' < "$L43h")"; fi
# G43i: a """ block string is a shape the reader will not parse — it refuses instead of narrowing
# on a guess, and under --engine store that is a hard stop with nothing sent
L43i="$TMP/sl43i"; : > "$L43i"
rc=0; M="$TMP/m43i"; GQL_LOG="$L43i" CURL_MARKER="$M" FAKE_EXEC_MODE=ok \
  run_gql --engine store --query block.graphql --operation FeBlock >"$O" 2>"$E" || rc=$?
assert G43i-block-string-engine-store 3 "$rc" "$E" "error=store_execute_failed "
if ! grep -q 'store execute' "$L43i" && [ ! -f "$M" ] && grep -q 'block string' "$E"; then ok
else bad G43i-block-string-nothing-sent "log=$(tr '\n' ';' < "$L43i") curl=$([ -f "$M" ] && echo yes || echo no) err=$(head -c 200 "$E" | tr '\n' ' ')"; fi
# G43j: the same document under --engine auto is a plain fallback — the token engine takes it
rc=0; M="$TMP/m43j"; CURL_MARKER="$M" FAKE_EXEC_MODE=ok \
  run_gql --query block.graphql --operation FeBlock >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -q '"ok":true' "$O" && [ -f "$M" ]; then ok
else bad G43j-block-string-falls-back "rc=$rc out=$(head -c 80 "$O") err=$(head -c 200 "$E" | tr '\n' ' ')"; fi
# G43k (pin): a single-operation document without --operation is handed over untouched — the
# original path on the argv, no temp copy, no --allow-mutations for a query
L43k="$TMP/sl43k"; : > "$L43k"
rc=0; GQL_LOG="$L43k" FAKE_EXEC_MODE=ok run_gql --query query.graphql >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -q -- '--query-file query.graphql ' "$L43k" \
   && ! grep -q -- '--allow-mutations' "$L43k"; then ok
else bad G43k-single-op-argv-unchanged "rc=$rc log=$(tr '\n' ';' < "$L43k")"; fi
# G43l: a directive between the operation name and its selection set is part of the declaration —
# refusing it would push a store-engine-only setup (no admin token at all) onto the token engine
QF43L="$TMP/qf43l.graphql"; rm -f "$QF43L"
rc=0; SHOPIFY_QF_SAVE="$QF43L" FAKE_EXEC_MODE=ok \
  run_gql --query directive.graphql --operation FeDir >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ "$(tr -d ' \n' < "$QF43L" 2>/dev/null)" = 'queryFeDir@someDirective{shop{name}}' ]; then ok
else bad G43l-operation-directive "rc=$rc qf=$(tr '\n' ';' < "$QF43L" 2>&1) err=$(head -c 160 "$E" | tr '\n' ' ')"; fi
# G43m (bug): the block-string refusal was raised off the RAW line, so a """ merely written inside
# a # comment condemned a document the reader can in fact read
L43m="$TMP/sl43m"; : > "$L43m"; QF43M="$TMP/qf43m.graphql"; rm -f "$QF43M"
rc=0; GQL_LOG="$L43m" SHOPIFY_QF_SAVE="$QF43M" FAKE_EXEC_MODE=ok \
  run_gql --query hashquotes.graphql --operation FeHash >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ "$(grep -c 'store execute' "$L43m")" -eq 1 ] && ! grep -q 'block string' "$E" \
   && grep -q '^query FeHash' "$QF43M" && ! grep -q 'FeOther' "$QF43M"; then ok
else bad G43m-quotes-in-comment "rc=$rc qf=$(tr '\n' ';' < "$QF43M" 2>&1) err=$(head -c 200 "$E" | tr '\n' ' ')"; fi
# G43n (bug): a shape the reader refuses is only a reason to step aside when something has to be
# NARROWED. With one operation and no --operation there is nothing to narrow, so the document goes
# over untouched — refusing it pushed a store-auth-only setup (no admin token at all) onto curl
L43n="$TMP/sl43n"; : > "$L43n"
rc=0; GQL_LOG="$L43n" FAKE_EXEC_MODE=ok run_gql --engine store --query block.graphql >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -q -- '--query-file block.graphql ' "$L43n" \
   && ! grep -q -- '--allow-mutations' "$L43n"; then ok
else bad G43n-block-string-no-narrowing "rc=$rc log=$(tr '\n' ';' < "$L43n") err=$(head -c 200 "$E" | tr '\n' ' ')"; fi
# G43o: and when that unreadable document is a MUTATION the opt-in still has to be there — the
# kind cannot come from the reader, so it degrades to "does this file mention a mutation at all"
L43o="$TMP/sl43o"; : > "$L43o"
rc=0; GQL_LOG="$L43o" FAKE_EXEC_MODE=ok run_gql --engine store --query blockmut.graphql >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -q -- '--query-file blockmut.graphql ' "$L43o" \
   && grep -q -- '--allow-mutations' "$L43o"; then ok
else bad G43o-block-string-mutation-optin "rc=$rc log=$(tr '\n' ';' < "$L43o")"; fi
# G43p: a top-level token the reader does not know IS a refusal while narrowing — the reason names
# the token instead of a bare "cannot parse"
L43p="$TMP/sl43p"; : > "$L43p"
rc=0; M="$TMP/m43p"; GQL_LOG="$L43p" CURL_MARKER="$M" FAKE_EXEC_MODE=ok \
  run_gql --engine store --query schema.graphql --operation FeSchema >"$O" 2>"$E" || rc=$?
assert G43p-unrecognized-token 3 "$rc" "$E" "unrecognized top-level token 'type'"
if ! grep -q 'store execute' "$L43p" && [ ! -f "$M" ]; then ok
else bad G43p-unrecognized-nothing-sent "log=$(tr '\n' ';' < "$L43p") curl=$([ -f "$M" ] && echo yes || echo no)"; fi
# G43q (bug): a UTF-8 BOM aborted the reader (multibyte conversion failure), and the swallowed
# stderr made that read as "0 operations" — a document that used to be sent became a refusal
L43q="$TMP/sl43q"; : > "$L43q"
rc=0; GQL_LOG="$L43q" FAKE_EXEC_MODE=ok run_gql --engine store --query bom.graphql >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -q -- '--query-file bom.graphql ' "$L43q"; then ok
else bad G43q-bom-still-sent "rc=$rc log=$(tr '\n' ';' < "$L43q") err=$(head -c 200 "$E" | tr '\n' ' ')"; fi
# G43r (bug): every fragment in the document rode along, so the narrowed text carried one the
# operation never spreads — GraphQL rejects that outright, and a definitive GraphQL error is the
# one store-engine failure with no fallback left
QF43R="$TMP/qf43r.graphql"; rm -f "$QF43R"
rc=0; SHOPIFY_QF_SAVE="$QF43R" FAKE_EXEC_MODE=ok \
  run_gql --query multi.graphql --operation FeB >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^mutation FeB' "$QF43R" && ! grep -q 'fragment' "$QF43R"; then ok
else bad G43r-unused-fragment-dropped "rc=$rc qf=$(tr '\n' ';' < "$QF43R" 2>&1)"; fi

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

# G45 (pin): today's `store execute --json` prints BARE data and the runner wraps it into the
# classic envelope
rc=0; FAKE_EXEC_MODE=ok run_gql --query query.graphql >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ "$(jq -c . "$O" 2>/dev/null)" = '{"data":{"ok":true}}' ]; then ok
else bad G45-bare-data-wrapped "rc=$rc out=$(head -c 120 "$O")"; fi
# G45b (bug): a CLI that starts printing the full envelope itself must not be wrapped twice —
# {"data":{"data":…}} is not an envelope any caller parses
rc=0; FAKE_EXEC_MODE=ok-envelope run_gql --query query.graphql >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ "$(jq -c . "$O" 2>/dev/null)" = '{"data":{"ok":true}}' ]; then ok
else bad G45b-envelope-not-double-wrapped "rc=$rc out=$(head -c 120 "$O")"; fi
# G45c: same for an {"errors":…} envelope — it passes through, so callers still gate on .errors
rc=0; FAKE_EXEC_MODE=ok-errors run_gql --query query.graphql >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ "$(jq -c '.errors[0].message' "$O" 2>/dev/null)" = '"Field x does not exist"' ] \
   && ! grep -q '"data"' "$O"; then ok
else bad G45c-errors-envelope-passthrough "rc=$rc out=$(head -c 120 "$O")"; fi

# G46 (bug): curl carried no timeouts, so a stalled Admin API call hung the caller — and every
# skill waiting on it — forever
A46="$TMP/curl-argv46"; : > "$A46"
rc=0; M="$TMP/m46"; CURL_MARKER="$M" CURL_ARGV="$A46" \
  run_gql --engine token --query query.graphql >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -q -- '--connect-timeout 20' "$A46" && grep -q -- '--max-time 120' "$A46"; then ok
else bad G46-curl-timeouts "rc=$rc argv=$(tr '\n' ';' < "$A46")"; fi

# G46b: the timeout itself is a transport failure — no half-response reaches stdout as data,
# and a QUERY carries no double-execution warning
rc=0; FAKE_CURL_RC=28 run_gql --engine token --query query.graphql >"$O" 2>"$E" || rc=$?
assert G46b-curl-timeout-rc 5 "$rc" "$E" "error=curl_transport_failed"
if [ ! -s "$O" ] && ! grep -q 'hint=' "$E"; then ok
else bad G46c-query-no-mutation-hint "out=$(head -c 80 "$O") err=$(head -c 200 "$E" | tr '\n' ' ')"; fi

# G46d: a MUTATION that times out mid-flight may already have committed server-side — the caller
# gets the same "verify before re-running" warning the store engine gives (G1)
rc=0; FAKE_CURL_RC=28 run_gql --engine token --query mutation.graphql >"$O" 2>"$E" || rc=$?
assert G46d-mutation-timeout-rc 5 "$rc" "$E" "error=curl_transport_failed"
if grep -q 'hint=the mutation may already have been applied' "$E"; then ok
else bad G46e-mutation-timeout-hint "err=$(head -c 200 "$E" | tr '\n' ' ')"; fi
# G46f (bug): the hazard was read off the WHOLE document, so a timed-out QUERY selected out of a
# mixed document claimed a mutation may have landed. Under --operation only the named block counts.
rc=0; FAKE_CURL_RC=28 run_gql --engine token --query multi.graphql --operation FeA >"$O" 2>"$E" || rc=$?
assert G46f-selected-query-timeout-rc 5 "$rc" "$E" "error=curl_transport_failed"
if ! grep -q 'hint=' "$E"; then ok
else bad G46f-selected-query-no-hint "err=$(head -c 200 "$E" | tr '\n' ' ')"; fi
# G46h: a failure that never put the request on the wire (DNS, connect refused, TLS) leaves nothing
# to have been applied — no hint, even for a mutation
rc=0; FAKE_CURL_RC=7 run_gql --engine token --query mutation.graphql >"$O" 2>"$E" || rc=$?
assert G46h-connect-failure-rc 5 "$rc" "$E" "error=curl_transport_failed"
if ! grep -q 'hint=' "$E"; then ok
else bad G46h-connect-failure-no-hint "err=$(head -c 200 "$E" | tr '\n' ' ')"; fi
# G46g: the mutation block from that same document still warns
rc=0; FAKE_CURL_RC=28 run_gql --engine token --query multi.graphql --operation FeB >"$O" 2>"$E" || rc=$?
if grep -q 'hint=the mutation may already have been applied' "$E"; then ok
else bad G46g-selected-mutation-hint "err=$(head -c 200 "$E" | tr '\n' ' ')"; fi
# G46i (bug): the hazard read was anchored to the start of a line, so a mutation declared mid-line
# timed out silently — the caller was never told the write may have landed
rc=0; FAKE_CURL_RC=28 run_gql --engine token --query onelinemix.graphql --operation FeMM >"$O" 2>"$E" || rc=$?
if grep -q 'hint=the mutation may already have been applied' "$E"; then ok
else bad G46i-inline-mutation-hint "err=$(head -c 200 "$E" | tr '\n' ' ')"; fi
# G46j: the query sharing that line stays quiet — the reader picks the named declaration, it does
# not just scan the file for the word
rc=0; FAKE_CURL_RC=28 run_gql --engine token --query onelinemix.graphql --operation FeML >"$O" 2>"$E" || rc=$?
if ! grep -q 'hint=' "$E"; then ok
else bad G46j-inline-query-no-hint "err=$(head -c 200 "$E" | tr '\n' ' ')"; fi
# G46k: on a document the reader refuses there is no declaration to consult, so the warning
# degrades to "does this file mention a mutation at all" — over-warning, never under-warning
rc=0; FAKE_CURL_RC=28 run_gql --engine token --query blockmut.graphql >"$O" 2>"$E" || rc=$?
if grep -q 'hint=the mutation may already have been applied' "$E"; then ok
else bad G46k-unreadable-mutation-hint "err=$(head -c 200 "$E" | tr '\n' ' ')"; fi
# G46l: and the degrade still says nothing about a document that holds no mutation at all
rc=0; FAKE_CURL_RC=28 run_gql --engine token --query block.graphql >"$O" 2>"$E" || rc=$?
if ! grep -q 'hint=' "$E"; then ok
else bad G46l-unreadable-query-no-hint "err=$(head -c 200 "$E" | tr '\n' ' ')"; fi

# G47: --api-version is the per-call way to a non-default Admin API version (SHOPIFY_ADMIN_API_VERSION
# is the ambient one), and each engine spells it somewhere else — the URL path for curl, `--version` on the CLI argv
A47="$TMP/curl-argv47"; : > "$A47"
rc=0; CURL_ARGV="$A47" run_gql --engine token --api-version 2099-01 --query query.graphql >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -q '/admin/api/2099-01/graphql.json' "$A47"; then ok
else bad G47-token-api-version "rc=$rc argv=$(tr '\n' ';' < "$A47")"; fi
L47="$TMP/sl47"; : > "$L47"
rc=0; GQL_LOG="$L47" FAKE_EXEC_MODE=ok \
  run_gql --engine store --api-version 2099-01 --query query.graphql >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -q -- '--version 2099-01' "$L47"; then ok
else bad G47b-store-api-version "rc=$rc calls=$(tr '\n' ';' < "$L47")"; fi
# G47c: with neither the flag nor SHOPIFY_ADMIN_API_VERSION the request still names a version —
# an empty segment there is a 404 on every call
A47C="$TMP/curl-argv47c"; : > "$A47C"
DEFV="$(sed -n 's/^API_VERSION="${SHOPIFY_ADMIN_API_VERSION:-\(.*\)}"$/\1/p' "$GQL")"
rc=0; CURL_ARGV="$A47C" run_gql --engine token --query query.graphql >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ -n "$DEFV" ] && grep -q "/admin/api/$DEFV/graphql.json" "$A47C"; then ok
else bad G47c-default-api-version "rc=$rc default=$DEFV argv=$(tr '\n' ';' < "$A47C")"; fi

# G49 (bug): `--help` used to be error=unknown_arg. It answers the call shape before the shared lib,
# the store resolution and the token read — no config, no credential, nothing on the wire — and it
# prints the header's own `# Usage:` block: two hand-maintained copies of a call shape are two
# copies free to disagree, and the header is the one a reader lands on.
GQLH="$TMP/gql-usage-header"
awk '/^# Usage:/ { f = 1 } f { if ($0 == "#" || $0 !~ /^#( |$)/) exit; sub(/^# ?/, ""); print }' \
  "$GQL" > "$GQLH"
for ha in --help -h; do
  rc=0; L49="$TMP/sl49"; : > "$L49"
  GQL_LOG="$L49" gql_run_at "$GQLDIR" "$ha" >"$O" 2>"$E" || rc=$?
  if [ "$rc" -eq 0 ] && [ ! -s "$E" ] && [ ! -s "$L49" ] \
     && [ "$(wc -l < "$GQLH" | tr -d ' ')" -eq 5 ] && sed '$d' "$O" | diff -q - "$GQLH" >/dev/null; then ok
  else bad "G49-help[$ha]" "rc=$rc diff=$(sed '$d' "$O" | diff - "$GQLH" | head -c 300 | tr '\n' ';') err=$(head -c 120 "$E" | tr '\n' ' ')"; fi
done
# G49b: the pointer line that follows it names where the full contract lives
if [ "$(tail -1 "$O")" = "Full contract: the header of $GQL" ]; then ok
else bad G49b-help-pointer "tail=$(tail -1 "$O")"; fi
# G49c: --help among a real call's args is still a usage question — nothing is sent
rc=0; L49C="$TMP/sl49c"; : > "$L49C"; A49C="$TMP/curl-argv49c"; : > "$A49C"
CURL_ARGV="$A49C" GQL_LOG="$L49C" gql_run_at "$GQLDIR" --store test-store --query query.graphql --help \
  >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^Usage:' "$O" && [ ! -s "$L49C" ] && [ ! -s "$A49C" ]; then ok
else bad G49c-help-mid-args "rc=$rc argv=$(tr '\n' ';' < "$A49C") log=$(tr '\n' ';' < "$L49C")"; fi
# G49d: …and the refusal a guessed flag gets names the way out in one step
rc=0; gql_run_at "$GQLDIR" --bogus >"$O" 2>"$E" || rc=$?
assert G49d-unknown-arg-trailer 2 "$rc" "$E" "error=unknown_arg arg=--bogus (--help prints usage)"
# G49e (drift guard): the usage block spells every flag the parse loop accepts — an arm added
# without a block update leaves --help lying about the accepted set. The floor fails an extraction
# that silently matched nothing.
GQLF="$(awk '/^while \[ \$# -gt 0 \]; do/ { f = 1 } f && /^done$/ { exit } f && match($0, /^ *--[a-z-]+\)/) { s = substr($0, RSTART, RLENGTH); sub(/^ */, "", s); sub(/\)$/, "", s); print s }' "$GQL" | sort -u)"
missing=""; n=0
for fl in $GQLF; do n=$((n + 1)); grep -q -- "${fl}[^a-z-]" "$GQLH" || missing="$missing $fl"; done
if [ "$n" -ge 9 ] && [ -z "$missing" ]; then ok
else bad G49e-usage-lists-flags "n=$n missing=[$missing]"; fi
# G49f: the scan is positional, which the header states outright — a flag VALUE of `-h` reads as a
# usage question, and the request it rode in on is never sent
rc=0; L49F="$TMP/sl49f"; : > "$L49F"; A49F="$TMP/curl-argv49f"; : > "$A49F"
CURL_ARGV="$A49F" GQL_LOG="$L49F" gql_run_at "$GQLDIR" --store test-store --query query.graphql --operation -h \
  >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^Usage:' "$O" && [ ! -s "$A49F" ] && grep -q 'VALUE of `-h`' "$GQL"; then ok
else bad G49f-help-in-value-position "rc=$rc argv=$(tr '\n' ';' < "$A49F") out=$(head -c 160 "$O" | tr '\n' ' ')"; fi

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
cp "$CPT" "$CPTD/cpt.sh"; cp "$COMMON" "$STL" "$CPTD/"
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
# FAKE_REJECT_STORE: every call at that store is the CLI's auth rejection — a token minted for another store
if [ -n "${FAKE_REJECT_STORE:-}" ]; then
  prev=""; for a in "$@"; do
    [ "$prev" = "--store" ] && [ "$a" = "$FAKE_REJECT_STORE" ] \
      && { printf '│  Invalid API key or access token (unrecognized login or wrong password)  │\n' >&2; exit 1; }
    prev="$a"
  done
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
    # FAKE_LIST2 + FAKE_LIST_MARK: a list answers FAKE_LIST while the mark file is absent and
    # FAKE_LIST2 once it exists — how a test shows a theme "appearing" mid-run. The CODE push drops
    # the mark (`--unpublished` creates the theme server-side before uploading, so even a failed
    # push leaves one behind); a build script dropping it instead plays a CONCURRENT run.
    if [ -n "${FAKE_LIST2:-}" ] && [ -f "${FAKE_LIST_MARK:-/dev/null}" ]; then printf '%s\n' "$FAKE_LIST2"
    elif [ -n "${FAKE_LIST:-}" ]; then printf '%s\n' "$FAKE_LIST"
    else cat <<'J'
[{"id":111,"name":"[DEV] Kever","role":"development"},{"id":555,"name":"[ABC-1] Kever","role":"unpublished"},{"id":999,"name":"Live Theme","role":"live"}]
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
    [ "$is_only" -eq 0 ] && [ -n "${FAKE_LIST_MARK:-}" ] && : > "$FAKE_LIST_MARK"
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
# plays a CONCURRENT run: the listing changes (FAKE_LIST → FAKE_LIST2) while THIS run is building
cat > "$CPTD/dropmark.sh" <<'W'
#!/usr/bin/env bash
: > "${FAKE_LIST_MARK:?}"
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
    "dropmark": "$CPTD/dropmark.sh",
    "waitpull": "$CPTD/waitpull.sh",
    "overlap": "$CPTD/overlap.sh",
    "failbuild": "exit 1"
  }
}
EOF
chmod +x "$CPTD/shim/shopify" "$CPTD/shim/npm" "$CPTD/waitpull.sh" "$CPTD/overlap.sh" "$CPTD/markbuild.sh" "$CPTD/dropmark.sh"

run_cpt_at() { # run_cpt_at <cwd> <path-prefix> <log-file> <env=val…> -- <args…>
  local dir="$1" pfx="$2" log="$3"; shift 3
  local envs=(); while [ "$1" != "--" ]; do envs+=("$1"); shift; done; shift
  (cd "$dir" && PATH="$pfx" CPT_LOG="$log" env "${envs[@]}" \
     "$BASH_BIN" "$CPTD/cpt.sh" "$@") >"$O" 2>"$E"
}
# the same run pinned to the fixture repo and its shim PATH — what nearly every case below wants
run_cpt() { # run_cpt <log-file> <env=val…> -- <args…>   ; stdout -> $O, stderr -> $E
  run_cpt_at "$CPTD/repo" "$CPTD/shim:$PATH" "$@"
}
cpt_calls() { grep -c "argv=$1" "$2" 2>/dev/null || true; }

# P0: the script sources _shopify-common.sh from its own dir — a copy without it stops with the
# stdout error= contract (exit 1) before the CLI is touched, so the fixture copy above is load-bearing
LONE_CPT="$TMP/lonecpt"; mkdir -p "$LONE_CPT"; cp "$CPT" "$LONE_CPT/cpt.sh"
rc=0; L="$TMP/cpt0"; : > "$L"
(cd "$CPTD/repo" && PATH="$CPTD/shim:$PATH" CPT_LOG="$L" "$BASH_BIN" "$LONE_CPT/cpt.sh" info) >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 1 ] && grep -q "^error=common_lib_not_found path=$LONE_CPT/_shopify-common.sh$" "$O" && [ ! -s "$L" ]; then ok
else bad P0-common-lib-missing "rc=$rc out=$(head -c 160 "$O" | tr '\n' ' ') log=$(tr '\n' ';' < "$L")"; fi

# P0b: same contract for the pin library — the _shopify-common.sh copy is load-bearing here,
# without it P0's guard answers first and this case proves nothing
LONE_ST="$TMP/lonecpt-st"; mkdir -p "$LONE_ST"; cp "$CPT" "$LONE_ST/cpt.sh"; cp "$COMMON" "$LONE_ST/"
rc=0; L="$TMP/cpt0b"; : > "$L"
(cd "$CPTD/repo" && PATH="$CPTD/shim:$PATH" CPT_LOG="$L" "$BASH_BIN" "$LONE_ST/cpt.sh" info) >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 1 ] && grep -q "^error=session_lib_not_found path=$LONE_ST/session-theme.sh$" "$O" && [ ! -s "$L" ]; then ok
else bad P0b-session-lib-missing "rc=$rc out=$(head -c 160 "$O" | tr '\n' ' ') log=$(tr '\n' ';' < "$L")"; fi

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
run_cpt "$L" FAKE_LIST='[{"id":111,"name":"[DEV] Kever","role":"development"},{"id":555,"name":"PREVIEW-X","role":"unpublished"}]' \
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

# P62 (bug): run from inside a task workspace, the config was `not found` — the toml is now the
# nearest one up to the checkout root; everything else stays cwd-relative, so a write mode from
# there is still refused as the wrong directory before anything is built or pushed
P62="$TMP/cpt62"; mkdir -p "$P62/.claude/tasks/ABC-1/tmp" "$P62/assets"; git -C "$P62" init -q 2>/dev/null
cp "$CPTD/repo/shopify.theme.toml" "$P62/"
rc=0; L="$TMP/cpt62l"; : > "$L"
run_cpt_at "$P62/.claude/tasks/ABC-1/tmp" "$CPTD/shim:$PATH" "$L" NO=1 -- info || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^store=acme-dev$' "$O" && grep -q '^dev_theme_id=111$' "$O"; then ok
else bad P62-toml-from-task-subdir "rc=$rc out=$(tr '\n' ';' < "$O")"; fi
rc=0; L="$TMP/cpt62b"; : > "$L"
run_cpt_at "$P62/.claude/tasks/ABC-1/tmp" "$CPTD/shim:$PATH" "$L" NO=1 -- refresh --theme 555 --no-build || rc=$?
if [ "$rc" -ne 0 ] && grep -q '^error=not_a_theme_checkout' "$O" && [ "$(cpt_calls 'theme push' "$L")" -eq 0 ]; then ok
else bad P62b-subdir-write-still-refused "rc=$rc out=$(head -c 160 "$O" | tr '\n' ' ')"; fi
# P62c: outside a checkout the lookup is the cwd's alone, message unchanged
rc=0; L="$TMP/cpt62c"; : > "$L"; mkdir -p "$TMP/cpt62-nogit/sub"; cp "$CPTD/repo/shopify.theme.toml" "$TMP/cpt62-nogit/"
run_cpt_at "$TMP/cpt62-nogit/sub" "$CPTD/shim:$PATH" "$L" NO=1 -- info || rc=$?
if [ "$rc" -eq 1 ] && grep -q '^error=config not found: shopify.theme.toml (run from the project root, or set TOML_PATH)$' "$O"; then ok
else bad P62c-no-git-unchanged "rc=$rc out=$(head -c 160 "$O" | tr '\n' ' ')"; fi
# P62d/P62e: from the physical `.claude/tasks/<id>` of a checkout with linked worktrees the walk
# picks nothing, so `pin` / `--pin-toml` can never rewrite a toml that may be the other checkout's
P62W="$TMP/cpt62w"; mkdir -p "$P62W/.claude/tasks/ABC-1" "$P62W/assets"; git -C "$P62W" init -q 2>/dev/null
mkdir -p "$P62W/.git/worktrees/wt"; cp "$CPTD/repo/shopify.theme.toml" "$P62W/"
P62H="$(cksum < "$P62W/shopify.theme.toml")"; P62C="$(cd "$P62W/.claude/tasks/ABC-1" && pwd -P)"
for P62A in "pin --theme 222" "create --name X --no-build --pin-toml"; do
  rc=0; L="$TMP/cpt62d"; : > "$L"
  # shellcheck disable=SC2086
  run_cpt_at "$P62C" "$CPTD/shim:$PATH" "$L" FAKE_LIST='[{"id":111,"name":"[DEV] Kever","role":"development"},{"id":222,"name":"[ABC-1] session","role":"unpublished"},{"id":999,"name":"Live Theme","role":"live"}]' -- $P62A || rc=$?
  if [ "$rc" -ne 0 ] && [ "$(cpt_calls 'theme push' "$L")" -eq 0 ] && grep -q '^note=toml_walk_skipped dir=' "$E" \
     && [ "$(cksum < "$P62W/shopify.theme.toml")" = "$P62H" ]; then ok
  else bad "P62d-linked-worktrees-no-write ($P62A)" "rc=$rc out=$(head -c 160 "$O" | tr '\n' ' ') err=$(head -c 160 "$E" | tr '\n' ' ')"; fi
done

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
run_cpt "$L" FAKE_LIST='[{"id":111,"name":"[DEV] Kever","role":"development"},{"id":555,"name":"PREVIEW-X","role":"unpublished"}]' FAKE_PUSH_ONLY_FAIL='Error: socket hang up' \
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
mkdir -p "$CPTD/repo/.claude/tasks/ABC-1"
printf -- '- 2026-09-06 session-theme: 555 ([ABC-1] Kever) https://acme-dev.myshopify.com/?preview_theme_id=555\n' > "$CPTD/repo/.claude/tasks/ABC-1/notes.md"
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
[{"id":999,"name":"Live Theme","role":"live"},{"id":111,"name":"[DEV] Kever","role":"development"},{"id":555,"name":"[ABC-1] Kever","role":"unpublished"}]'
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
run_cpt "$L" FAKE_LIST='Fetching themes... [{"id":999,"name":"Live Theme","role":"live"},{"id":111,"name":"[DEV] Kever","role":"development"},{"id":555,"name":"[ABC-1] Kever","role":"unpublished"}]' \
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

# ------------------------- create-preview-theme.sh: a checkout with no ./package.json --
# A plain theme repo has nothing to build, and refusing there (`build_script_missing`) blocked the
# push over a build that does not exist. The build is SKIPPED instead and the working tree ships;
# an EXPLICIT --build-script still refuses, because a build the caller asked for and we cannot run
# must not be silently dropped. Two fixture repos, both carrying the same toml and theme dirs as
# $CPTD/repo: one without package.json at all, one whose package.json lacks the default script.
CPTNP="$CPTD/repo-nopkg"; CPTNS="$CPTD/repo-noscript"
for d in "$CPTNP" "$CPTNS"; do
  # the `.git` is the repo boundary the package.json walk-up stops at: without it the skip cases
  # would answer about whatever sits above the harness's temp dir on the developer's machine
  mkdir -p "$d/assets" "$d/sections" "$d/.git"
  cp "$CPTD/repo/assets/app.css" "$d/assets/"
  cp "$CPTD/repo/sections/main-product.liquid" "$d/sections/"
  cp "$CPTD/repo/shopify.theme.toml" "$d/"
done
printf '{"name":"cpt-noscript","private":true,"scripts":{"lint":"true"}}\n' > "$CPTNS/package.json"

# P19j: create with no flags in a package.json-less checkout skips the build and still pushes,
# saying so in both the built= key and one warn= line (npm is never invoked)
rc=0; L="$TMP/cpt19j"; : > "$L"
run_cpt_at "$CPTNP" "$CPTD/shim:$PATH" "$L" NO=1 -- create --name "PREVIEW-NP" || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^built=skipped_no_package_json$' "$O" \
   && [ "$(grep -c '^warn=build_skipped_no_package_json' "$O")" -eq 1 ] \
   && [ "$(cpt_calls 'theme push' "$L")" -ge 1 ] && ! grep -q '^npm=' "$L"; then ok
else bad P19j-create-no-package-json-skips "rc=$rc out=$(tr '\n' ';' < "$O") npm=$(grep '^npm=' "$L" | tr '\n' ';')"; fi

# P19k: and it needs no node — the package.json lookup is what node was for, so a host without it
# must still get the preview (T42's pattern, same helper).
NONODE="$TMP/cpt-nonode-bin"
path_without "$NONODE" node \
  jq mktemp sed awk grep cat cp mv rm mkdir find sleep tail head tr sort uniq wc cmp \
  chmod touch date basename dirname stat env ls bash sh
if ( PATH="$CPTD/shim:$NONODE"; command -v node >/dev/null 2>&1 ); then
  bad P19k-no-node-path "the no-node PATH still resolves node — the case below would prove nothing"
else
  rc=0; L="$TMP/cpt19k"; : > "$L"
  run_cpt_at "$CPTNP" "$CPTD/shim:$NONODE" "$L" NO=1 -- refresh --theme 555 || rc=$?
  if [ "$rc" -eq 0 ] && grep -q '^built=skipped_no_package_json$' "$O" \
     && [ "$(cpt_calls 'theme push' "$L")" -eq 1 ]; then ok
  else bad P19k-refresh-no-node-skips "rc=$rc out=$(tr '\n' ';' < "$O") err=$(head -c 200 "$E" | tr '\n' ' ')"; fi
fi

# P19l/P19m: an EXPLICIT --build-script in the same checkout is refused before the store instead —
# both arg loops, since each mode parses the flag on its own
rc=0; L="$TMP/cpt19l"; : > "$L"
run_cpt_at "$CPTNP" "$CPTD/shim:$PATH" "$L" NO=1 -- create --name "PREVIEW-NP2" --build-script build || rc=$?
if [ "$rc" -ne 0 ] && grep -q 'error=build_script_missing (build)' "$O" && grep -q 'no ./package.json' "$O" \
   && [ "$(cpt_calls 'theme' "$L")" -eq 0 ] && ! grep -q '^npm=' "$L"; then ok
else bad P19l-create-explicit-script-no-package-json "rc=$rc out=$(head -c 200 "$O" | tr '\n' ' ')"; fi
rc=0; L="$TMP/cpt19m"; : > "$L"
run_cpt_at "$CPTNP" "$CPTD/shim:$PATH" "$L" NO=1 -- refresh --theme 555 --build-script build || rc=$?
if [ "$rc" -ne 0 ] && grep -q 'error=build_script_missing (build)' "$O" && grep -q 'no ./package.json' "$O" \
   && [ "$(cpt_calls 'theme' "$L")" -eq 0 ] && ! grep -q '^npm=' "$L"; then ok
else bad P19m-refresh-explicit-script-no-package-json "rc=$rc out=$(head -c 200 "$O" | tr '\n' ' ')"; fi

# P19n: --no-build is unchanged — it never looked at package.json, so its verdict stays `skipped`
# and carries no warn line (a caller reading built= must be able to tell the two apart)
rc=0; L="$TMP/cpt19n"; : > "$L"
run_cpt_at "$CPTNP" "$CPTD/shim:$PATH" "$L" NO=1 -- refresh --theme 555 --no-build || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^built=skipped$' "$O" && ! grep -q 'no_package_json' "$O" \
   && ! grep -q '^npm=' "$L"; then ok
else bad P19n-no-build-unchanged "rc=$rc out=$(tr '\n' ';' < "$O")"; fi

# P19o: the other half of the split — a package.json that EXISTS without the script is still the
# refusal, before the store. Only "no package.json at all" is the skip.
rc=0; L="$TMP/cpt19o"; : > "$L"
run_cpt_at "$CPTNS" "$CPTD/shim:$PATH" "$L" NO=1 -- create --name "PREVIEW-NS" || rc=$?
if [ "$rc" -ne 0 ] && grep -q 'error=build_script_missing (build)' "$O" \
   && grep -q 'scripts' "$O" && [ "$(cpt_calls 'theme' "$L")" -eq 0 ]; then ok
else bad P19o-package-json-without-script "rc=$rc out=$(head -c 200 "$O" | tr '\n' ' ')"; fi

# P19p (bug): the wrong directory is not a build question. A cwd with no theme directory must be
# refused before the store — assemble_theme would hand `theme push` an empty root, and a code push
# carries no --nodelete, so the theme would be stripped. `theme` (not `theme push`) in the call
# count: the guard runs before the listing too, so NOTHING may reach the CLI.
CPTWD="$TMP/cpt-wrongdir"; mkdir -p "$CPTWD"
rc=0; L="$TMP/cpt19p"; : > "$L"
run_cpt_at "$CPTWD" "$CPTD/shim:$PATH" "$L" NO=1 TOML_PATH="$CPTNP/shopify.theme.toml" \
  -- refresh --theme 555 || rc=$?
if [ "$rc" -ne 0 ] && grep -q 'error=not_a_theme_checkout' "$O" \
   && [ "$(cpt_calls 'theme' "$L")" -eq 0 ] && ! grep -q '^npm=' "$L"; then ok
else bad P19p-wrong-directory-refused "rc=$rc out=$(head -c 240 "$O" | tr '\n' ' ') calls=$(cpt_calls 'theme' "$L")"; fi
# and the same for `create`, which reaches the push through its own path
rc=0; L="$TMP/cpt19p2"; : > "$L"
run_cpt_at "$CPTWD" "$CPTD/shim:$PATH" "$L" NO=1 TOML_PATH="$CPTNP/shopify.theme.toml" \
  -- create --name "PREVIEW-WD" || rc=$?
if [ "$rc" -ne 0 ] && grep -q 'error=not_a_theme_checkout' "$O" \
   && [ "$(cpt_calls 'theme' "$L")" -eq 0 ] && ! grep -q '^npm=' "$L"; then ok
else bad P19p2-wrong-directory-create-refused "rc=$rc out=$(head -c 240 "$O" | tr '\n' ' ')"; fi

# P19p3/P19p4 (bug): --no-build must not smuggle an empty push root past that guard. The
# refusal is about the directory, so it lands in both modes with the flag on — a cwd carrying only
# the toml (one `cd` too far, or the toml's own directory) is exactly where that happens.
CPTWDT="$TMP/cpt-wrongdir-toml"; mkdir -p "$CPTWDT"; cp "$CPTNP/shopify.theme.toml" "$CPTWDT/"
rc=0; L="$TMP/cpt19p3"; : > "$L"
run_cpt_at "$CPTWDT" "$CPTD/shim:$PATH" "$L" NO=1 -- refresh --theme 555 --no-build || rc=$?
if [ "$rc" -ne 0 ] && grep -q 'error=not_a_theme_checkout' "$O" \
   && [ "$(cpt_calls 'theme' "$L")" -eq 0 ]; then ok
else bad P19p3-no-build-wrong-directory-refresh "rc=$rc out=$(head -c 240 "$O" | tr '\n' ' ') calls=$(cpt_calls 'theme' "$L")"; fi
rc=0; L="$TMP/cpt19p4"; : > "$L"
run_cpt_at "$CPTWDT" "$CPTD/shim:$PATH" "$L" NO=1 -- create --name "PREVIEW-WDNB" --no-build || rc=$?
if [ "$rc" -ne 0 ] && grep -q 'error=not_a_theme_checkout' "$O" \
   && [ "$(cpt_calls 'theme' "$L")" -eq 0 ]; then ok
else bad P19p4-no-build-wrong-directory-create "rc=$rc out=$(head -c 240 "$O" | tr '\n' ' ')"; fi

# P19p5 (bug): a package.json buys no way past it either — the directory refusal is settled before
# the build decision, so a buildable cwd with no theme dirs must still be refused, and with no
# build run.
CPTWDP="$TMP/cpt-wrongdir-pkg"; mkdir -p "$CPTWDP"; cp "$CPTNP/shopify.theme.toml" "$CPTWDP/"
printf '{"name":"cpt-wrongdir","private":true,"scripts":{"build":"true"}}\n' > "$CPTWDP/package.json"
rc=0; L="$TMP/cpt19p5"; : > "$L"
run_cpt_at "$CPTWDP" "$CPTD/shim:$PATH" "$L" NO=1 -- create --name "PREVIEW-WDP" || rc=$?
if [ "$rc" -ne 0 ] && grep -q 'error=not_a_theme_checkout' "$O" \
   && [ "$(cpt_calls 'theme' "$L")" -eq 0 ] && ! grep -q '^npm=' "$L"; then ok
else bad P19p5-package-json-wrong-directory "rc=$rc out=$(head -c 240 "$O" | tr '\n' ' ') npm=$(grep -c '^npm=' "$L")"; fi

# P19q: "no package.json" means no such entry at all. One that is present but not a regular file
# (a directory here) keeps the node-driven refusal it had before the skip existed — the skip may
# not be reached by anything the old code would have refused.
CPTPD="$TMP/cpt-pkgdir"; mkdir -p "$CPTPD/assets" "$CPTPD/sections" "$CPTPD/package.json"
cp "$CPTD/repo/assets/app.css" "$CPTPD/assets/"; cp "$CPTD/repo/shopify.theme.toml" "$CPTPD/"
rc=0; L="$TMP/cpt19q"; : > "$L"
run_cpt_at "$CPTPD" "$CPTD/shim:$PATH" "$L" NO=1 -- refresh --theme 555 || rc=$?
if [ "$rc" -ne 0 ] && grep -q 'error=build_script_missing (build)' "$O" \
   && ! grep -q 'skipped_no_package_json' "$O" && [ "$(cpt_calls 'theme push' "$L")" -eq 0 ]; then ok
else bad P19q-package-json-not-a-file "rc=$rc out=$(head -c 240 "$O" | tr '\n' ' ')"; fi

# P19r (bug): "no ./package.json" also describes a run started in a SUBDIRECTORY of a project whose
# package.json sits above it — the build exists and was skipped, so the push would ship an unbuilt
# subtree. That is the refusal it was before the skip existed, naming the directory to run from.
CPTSUB="$TMP/cpt-monorepo"; mkdir -p "$CPTSUB/.git" "$CPTSUB/theme/assets" "$CPTSUB/theme/sections"
printf '{"name":"cpt-monorepo","private":true,"scripts":{"build":"true"}}\n' > "$CPTSUB/package.json"
cp "$CPTD/repo/assets/app.css" "$CPTSUB/theme/assets/"
cp "$CPTD/repo/sections/main-product.liquid" "$CPTSUB/theme/sections/"
cp "$CPTD/repo/shopify.theme.toml" "$CPTSUB/theme/"
# the walk is physical (as project-profile.sh's is), so the path it names is the physical one —
# the sim's own temp root already lives under a symlink on macOS (/var -> /private/var)
CPTSUB_P="$(cd "$CPTSUB" && pwd -P)"
rc=0; L="$TMP/cpt19r"; : > "$L"
run_cpt_at "$CPTSUB/theme" "$CPTD/shim:$PATH" "$L" NO=1 -- create --name "PREVIEW-SUB" || rc=$?
if [ "$rc" -ne 0 ] && grep -q "error=build_script_missing (build)" "$O" \
   && grep -qF "./package.json is at $CPTSUB_P" "$O" \
   && ! grep -q 'skipped_no_package_json' "$O" \
   && [ "$(cpt_calls 'theme' "$L")" -eq 0 ] && ! grep -q '^npm=' "$L"; then ok
else bad P19r-package-json-in-ancestor "rc=$rc out=$(head -c 240 "$O" | tr '\n' ' ')"; fi

# P19r2 (bug): the same subdirectory reached through a SYMLINK. A logical walk tests the link's
# parent, finds no package.json, and pushes the unbuilt subtree; symlinked project roots are
# ordinary (/Users/x/work -> /Volumes/…), so the answer must not depend on the route taken.
CPTSUBL="$TMP/cpt-monorepo-link"; ln -s "$CPTSUB/theme" "$CPTSUBL"
rc=0; L="$TMP/cpt19r2"; : > "$L"
run_cpt_at "$CPTSUBL" "$CPTD/shim:$PATH" "$L" NO=1 -- refresh --theme 555 || rc=$?
if [ "$rc" -ne 0 ] && grep -q "error=build_script_missing (build)" "$O" \
   && grep -qF "./package.json is at $CPTSUB_P" "$O" \
   && ! grep -q 'skipped_no_package_json' "$O" \
   && [ "$(cpt_calls 'theme' "$L")" -eq 0 ] && ! grep -q '^npm=' "$L"; then ok
else bad P19r2-package-json-in-ancestor-via-symlink "rc=$rc out=$(head -c 240 "$O" | tr '\n' ' ')"; fi

# P19s: a package.json that is a DANGLING symlink is a broken project, not a project without one —
# the entry exists, so the skip may not claim it (it kept the node-driven refusal before the skip).
CPTPL="$TMP/cpt-pkglink"; mkdir -p "$CPTPL/assets" "$CPTPL/sections"
cp "$CPTD/repo/assets/app.css" "$CPTPL/assets/"
cp "$CPTD/repo/sections/main-product.liquid" "$CPTPL/sections/"
cp "$CPTD/repo/shopify.theme.toml" "$CPTPL/"; ln -s ./nowhere.json "$CPTPL/package.json"
rc=0; L="$TMP/cpt19s"; : > "$L"
run_cpt_at "$CPTPL" "$CPTD/shim:$PATH" "$L" NO=1 -- refresh --theme 555 || rc=$?
if [ "$rc" -ne 0 ] && grep -q 'error=build_script_missing (build)' "$O" \
   && ! grep -q 'skipped_no_package_json' "$O" \
   && [ "$(cpt_calls 'theme' "$L")" -eq 0 ] && ! grep -q '^npm=' "$L"; then ok
else bad P19s-package-json-dangling-symlink "rc=$rc out=$(head -c 240 "$O" | tr '\n' ' ')"; fi

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

# P23b (bug): `refresh` onto an id ABSENT from a readable listing — what a DELETED preview theme
# looks like. It used to build, push, and learn the truth from the CLI's boxed "No themes on the
# store … match the ID" behind error=refresh_push_failed, which reads like a push that may have
# landed. The pin branch already makes this call; refresh makes it too, before the build (no
# --no-build here: `npm=` absent is the proof the refusal came first).
rc=0; L="$TMP/cpt23b"; : > "$L"
run_cpt "$L" FAKE_LIST='[{"id":222,"name":"Other","role":"unpublished"}]' -- refresh --theme 333 || rc=$?
RC23B="$rc"
if [ "$rc" -eq 1 ] && grep -q '^error=theme_not_found theme=333 store=acme-dev' "$O" \
   && grep -q 'create --name' "$O" \
   && [ "$(cpt_calls 'theme push' "$L")" -eq 0 ] && ! grep -q '^npm=' "$L"; then ok
else bad P23b-absent-id-refused "rc=$rc out=$(head -c 200 "$O" | tr '\n' ' ') log=$(tr '\n' ';' < "$L")"; fi
# P23c: the same id through `pin` — one refusal, one exit code, whichever branch raises it
rc=0; L="$TMP/cpt23c"; : > "$L"
run_cpt "$L" FAKE_LIST='[{"id":222,"name":"Other","role":"unpublished"}]' -- pin --theme 333 || rc=$?
if [ "$rc" -eq "$RC23B" ] && grep -q '^error=theme_not_found theme=333 store=acme-dev' "$O"; then ok
else bad P23c-pin-exit-parity "pin rc=$rc refresh rc=$RC23B out=$(head -c 160 "$O" | tr '\n' ' ')"; fi
# P23d: --allow-unverified answers a listing that gave no ANSWER, never one that answered and does
# not carry the id — a deleted theme is not a verification problem, so the flag is not a lift
rc=0; L="$TMP/cpt23d"; : > "$L"
run_cpt "$L" FAKE_LIST='[{"id":222,"name":"Other","role":"unpublished"}]' \
  -- refresh --theme 333 --no-build --allow-unverified || rc=$?
if [ "$rc" -eq 1 ] && grep -q '^error=theme_not_found theme=333' "$O" \
   && [ "$(cpt_calls 'theme push' "$L")" -eq 0 ]; then ok
else bad P23d-allow-unverified-no-lift "rc=$rc out=$(head -c 200 "$O" | tr '\n' ' ')"; fi
# P23e (fail-open): a listing that PARSES but names no theme is an outage, not a store with no
# themes (P11e) — absence means nothing there, so the recorded session theme still refreshes and
# the id is never called not-found. The one gate that separates the two is THEME_LIST_SILENT.
mkdir -p "$CPTD/repo/.claude/tasks/ABC-2"
printf -- '- 2026-09-13 session-theme: 777 ([ABC-2] Kever) https://acme-dev.myshopify.com/?preview_theme_id=777\n' \
  > "$CPTD/repo/.claude/tasks/ABC-2/notes.md"
rc=0; L="$TMP/cpt23e"; : > "$L"
run_cpt "$L" FAKE_LIST='[]' -- refresh --theme 777 --no-build || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^theme_id=777$' "$O" && ! grep -q 'theme_not_found' "$O" \
   && [ "$(cpt_calls 'theme push' "$L")" -eq 1 ]; then ok
else bad P23e-empty-listing-not-a-deletion "rc=$rc out=$(head -c 200 "$O" | tr '\n' ' ')"; fi
# …and a listing the CLI never gave at all is the refresh_unverifiable path, untouched
rc=0; L="$TMP/cpt23f"; : > "$L"
run_cpt "$L" FAKE_LIST_FAIL=1 -- refresh --theme 777 --no-build || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^theme_id=777$' "$O" && ! grep -q 'theme_not_found' "$O"; then ok
else bad P23f-outage-not-a-deletion "rc=$rc out=$(head -c 200 "$O" | tr '\n' ' ')"; fi
rm -rf "$CPTD/repo/.claude"

# P23g (bug): the refusal above is refresh's only unliftable one, so it may not fire on a listing
# whose ids it cannot read. `theme list --json` also spells ids as gids (P17b/P41b are the shapes
# this store really produces), and an exact string compare answers "not on the store" for every one
# of them — turning the routine refresh into a dead end whose own hint (`create --reuse`) then dies
# on `unusable_theme_id`. The id is matched on its numeric tail instead.
GIDL='[{"id":"gid://shopify/OnlineStoreTheme/111","name":"[DEV] Kever","role":"development"},{"id":"gid://shopify/OnlineStoreTheme/555","name":"[ABC-1] Kever","role":"unpublished"},{"id":"gid://shopify/OnlineStoreTheme/999","name":"Live Theme","role":"live"}]'
rc=0; L="$TMP/cpt23g"; : > "$L"
run_cpt "$L" FAKE_LIST="$GIDL" -- refresh --theme 555 --no-build || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^theme_id=555$' "$O" && ! grep -q 'theme_not_found' "$O" \
   && [ "$(cpt_calls 'theme push' "$L")" -eq 1 ]; then ok
else bad P23g-gid-listing-refreshes "rc=$rc out=$(head -c 200 "$O" | tr '\n' ' ') log=$(tr '\n' ';' < "$L")"; fi
# …and the same dialect still catches a deletion: tolerance is in the compare, not in the gate
rc=0; L="$TMP/cpt23h"; : > "$L"
run_cpt "$L" FAKE_LIST="$GIDL" -- refresh --theme 333 --no-build || rc=$?
if [ "$rc" -eq 1 ] && grep -q '^error=theme_not_found theme=333 store=acme-dev' "$O" \
   && [ "$(cpt_calls 'theme push' "$L")" -eq 0 ]; then ok
else bad P23h-gid-listing-absent-id "rc=$rc out=$(head -c 200 "$O" | tr '\n' ' ')"; fi
# …and the live-theme guard reads that dialect too — it used to clear the PUBLISHED theme, because
# the role lookup compares the same id and a gid listing answered it with an empty role
rc=0; L="$TMP/cpt23i"; : > "$L"
run_cpt "$L" FAKE_LIST="$GIDL" -- refresh --theme 999 --no-build || rc=$?
if [ "$rc" -ne 0 ] && grep -q '^error=live_theme_write_refused theme=999 role=live' "$O" \
   && [ "$(cpt_calls 'theme push' "$L")" -eq 0 ]; then ok
else bad P23i-gid-listing-live-guard "rc=$rc out=$(head -c 200 "$O" | tr '\n' ' ')"; fi
# P23j (fail-open): a listing that parses and carries `id` keys the compare can make nothing of
# (no numeric tail on any of them) is a dialect this script does not speak — absence there is not a
# deletion, so the push goes ahead exactly as it did before the refusal existed
rc=0; L="$TMP/cpt23j"; : > "$L"
run_cpt "$L" FAKE_LIST='[{"id":null,"name":"X","role":"unpublished"}]' -- refresh --theme 333 --no-build || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^theme_id=333$' "$O" && ! grep -q 'theme_not_found' "$O"; then ok
else bad P23j-unreadable-id-dialect "rc=$rc out=$(head -c 200 "$O" | tr '\n' ' ')"; fi
# P23k: `pin` shares the matcher, so the gid listing vets there too — it used to refuse every id on
# such a store and a pin is the one refusal that leaves the developer no working command at all
FGP="$CPTD/toml/pin-gid-listing.toml"
printf '[environments.development]\nstore = "acme-dev"\ntheme = "111"\npassword = "shptka_fixture1234"\n' > "$FGP"
rc=0; L="$TMP/cpt23k"; : > "$L"
run_cpt "$L" TOML_PATH="$FGP" FAKE_LIST="$GIDL" -- pin --theme 555 || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^theme_id=555$' "$O" && grep -q '^pin=rewritten$' "$O" \
   && grep -qx 'theme = "555"' "$FGP"; then ok
else bad P23k-pin-gid-listing "rc=$rc out=$(tr '\n' ';' < "$O") toml=$(grep -v password "$FGP" | tr '\n' ';')"; fi

# P61 (bug): the OVERLAY SOURCE is as deletable as the target, and nothing vetted it — the code
# push does not use the toml's `theme =`, so a deleted dev theme let the push land and only the
# background settings pull fail (error=overlay_pull_failed + mixed_state=…, a theme carrying this
# branch's code over the settings it already had). Same evidence bar as theme_not_found, before
# the build: nothing built, nothing pushed, nothing pulled.
DEVLESS='[{"id":555,"name":"PREVIEW-X","role":"unpublished"},{"id":999,"name":"Live Theme","role":"live"}]'
for cmd in "create --name PREVIEW-X --reuse" "create --name PREVIEW-FRESH" "refresh --theme 555"; do
  rc=0; L="$TMP/cpt61"; : > "$L"
  run_cpt "$L" FAKE_LIST="$DEVLESS" -- $cmd || rc=$?
  if [ "$rc" -eq 1 ] \
     && grep -q '^error=dev_theme_not_found dev_theme=111 store=acme-dev — the theme pinned in ' "$O" \
     && grep -q 'pin an existing theme with `pin --theme <ID>` or fix the toml$' "$O" \
     && [ "$(cpt_calls 'theme push' "$L")" -eq 0 ] && [ "$(cpt_calls 'theme pull' "$L")" -eq 0 ] \
     && ! grep -q '^npm=' "$L"; then ok
  else bad "P61-dev-theme-not-found[$cmd]" "rc=$rc out=$(head -c 200 "$O" | tr '\n' ' ') log=$(grep -v token "$L" | tr '\n' ';')"; fi
done
# P61b: a listing that DOES carry it is the unchanged path — the run goes all the way through
rc=0; L="$TMP/cpt61b"; : > "$L"
run_cpt "$L" FAKE_LIST="[{\"id\":111,\"name\":\"[DEV] Kever\",\"role\":\"development\"},{\"id\":555,\"name\":\"PREVIEW-X\",\"role\":\"unpublished\"}]" \
  -- refresh --theme 555 --no-build || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^theme_id=555$' "$O" && ! grep -q 'dev_theme_not_found' "$O" \
   && [ "$(cpt_calls 'theme push' "$L")" -eq 1 ]; then ok
else bad P61b-dev-theme-listed "rc=$rc out=$(head -c 200 "$O" | tr '\n' ' ')"; fi
# P61c (fail-open): every shape of "the listing said nothing about ids" leaves absence meaningless,
# exactly as it does for theme_not_found — a silent call, output that is not JSON, a parseable
# listing naming no theme, and one whose ids carry no numeric tail. The run proceeds to its usual
# outcome and overlay_pull_failed stays the backstop.
i=0
for lst in "FAIL" "<html>503 Service Unavailable</html>" "[]" '[{"id":null,"name":"X","role":"unpublished"}]'; do
  i=$((i + 1)); rc=0; L="$TMP/cpt61c$i"; : > "$L"
  if [ "$lst" = FAIL ]; then run_cpt "$L" FAKE_LIST_FAIL=1 -- create --name "PREVIEW-FO$i" --no-build || rc=$?
  else run_cpt "$L" FAKE_LIST="$lst" -- create --name "PREVIEW-FO$i" --no-build || rc=$?; fi
  if ! grep -q 'dev_theme_not_found' "$O" && [ "$(cpt_calls 'theme push' "$L")" -ge 1 ]; then ok
  else bad "P61c-fail-open[$i]" "rc=$rc out=$(head -c 200 "$O" | tr '\n' ' ')"; fi
done
# P61d: a toml with no `theme =` at all never reaches the check — that config is refused first,
# and a refusal about the overlay source would name a value the file does not have
F61="$CPTD/toml/no-dev-theme.toml"
printf '[environments.development]\nstore = "acme-dev"\npassword = "shptka_fixture1234"\n' > "$F61"
rc=0; L="$TMP/cpt61d"; : > "$L"
run_cpt "$L" TOML_PATH="$F61" FAKE_LIST="$DEVLESS" -- refresh --theme 555 --no-build || rc=$?
if [ "$rc" -eq 1 ] && grep -q '^error=no uncommented ' "$O" && ! grep -q 'dev_theme_not_found' "$O" \
   && [ ! -s "$L" ]; then ok
else bad P61d-no-theme-line "rc=$rc out=$(head -c 200 "$O" | tr '\n' ' ') log=$(tr '\n' ';' < "$L")"; fi

# ------------------------------ create-preview-theme.sh build_dirtied + pushed= --
# A git checkout of the fixture: the build may rewrite a tracked file, and HEAD is the pushed commit.
CPTG="$TMP/cptgit"; cp -R "$CPTD/repo" "$CPTG"
cat > "$CPTG/package.json" <<'EOF'
{ "private": true, "scripts": { "build": "true", "dirty": "echo 'y{}' > assets/app.css" } }
EOF
cpt_git() { git -C "$CPTG" -c user.name=sim -c user.email=sim@example.com "$@"; }
cpt_git init -q; cpt_git add -A; cpt_git commit -q -m init
CPTG_SHA="$(cpt_git rev-parse HEAD)"

# P70: a build that rewrites a tracked file is named in one warn line on an exit-0 run (the theme is
# still pushed); a file the developer had already modified before the build is not the build's doing,
# but it rode along in the push, so no pushed= claims the theme carries HEAD
echo '<!-- wip -->' >> "$CPTG/sections/main-product.liquid"
rc=0; L="$TMP/cpt70"; : > "$L"
run_cpt_at "$CPTG" "$CPTD/shim:$PATH" "$L" NO=1 -- create --name "PREVIEW-DIRTY" --build-script dirty || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^theme_id=222$' "$O" && grep -q '^warn=build_dirtied=assets/app.css — ' "$O" \
   && ! grep -q '^pushed=' "$O" && [ "$(cpt_calls 'theme push' "$L")" -ge 1 ]; then ok
else bad P70-build-dirtied-warn "rc=$rc out=$(tr '\n' ';' < "$O")"; fi
cpt_git checkout -q -- .

# P70b: a clean build prints no build_dirtied line; refresh reports pushed= too
rc=0; L="$TMP/cpt70b"; : > "$L"
run_cpt_at "$CPTG" "$CPTD/shim:$PATH" "$L" NO=1 -- refresh --theme 555 || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^built=yes$' "$O" && ! grep -q 'build_dirtied' "$O" \
   && grep -q "^pushed=$CPTG_SHA$" "$O"; then ok
else bad P70b-clean-build-refresh-pushed "rc=$rc out=$(tr '\n' ';' < "$O")"; fi

# P70c: --no-build runs no build, so nothing can be dirtied by one; a clean create reports pushed=
rc=0; L="$TMP/cpt70c"; : > "$L"
run_cpt_at "$CPTG" "$CPTD/shim:$PATH" "$L" NO=1 -- create --name "PREVIEW-NB" --no-build || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^built=skipped$' "$O" && ! grep -q 'build_dirtied' "$O" \
   && grep -q "^pushed=$CPTG_SHA$" "$O"; then ok
else bad P70c-no-build-no-dirtied "rc=$rc out=$(tr '\n' ';' < "$O")"; fi

# P70d: an untracked theme file (pushed as it stands) or a tracked build input edited but not
# committed both withhold pushed=
echo '<p>wip</p>' > "$CPTG/sections/wip.liquid"
rc=0; L="$TMP/cpt70d"; : > "$L"
run_cpt_at "$CPTG" "$CPTD/shim:$PATH" "$L" NO=1 -- refresh --theme 555 --no-build || rc=$?
if [ "$rc" -eq 0 ] && ! grep -q '^pushed=' "$O"; then ok
else bad P70d-untracked-theme-file-no-pushed "rc=$rc out=$(tr '\n' ';' < "$O")"; fi
rm -f "$CPTG/sections/wip.liquid"
printf '\n' >> "$CPTG/package.json"
rc=0; L="$TMP/cpt70e"; : > "$L"
run_cpt_at "$CPTG" "$CPTD/shim:$PATH" "$L" NO=1 -- refresh --theme 555 || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^built=yes$' "$O" && ! grep -q '^pushed=' "$O"; then ok
else bad P70e-uncommitted-build-input-no-pushed "rc=$rc out=$(tr '\n' ';' < "$O")"; fi
cpt_git checkout -q -- .

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
# onto the `# fe:superseded` marker above it. The session id refreshes; the superseded one is
# still the shared theme and still refused.
FP54="$CPTD/toml/pinned.toml"
printf '[environments.development]\nstore = "acme-dev"\n# theme = "111"   # dev theme  # fe:superseded\ntheme = "555"   # dev theme\npassword = "shptka_fixture1234"\n' > "$FP54"
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
mkdir -p "$CPTD/repo/.claude/tasks/ABC-1"
printf -- '- 2026-09-06 worktree `x` on branch `y`, dev-port: 9293\n- 2026-09-06 session-theme: 555 ([ABC-1] Kever) https://acme-dev.myshopify.com/?preview_theme_id=555\n' > "$CPTD/repo/.claude/tasks/ABC-1/notes.md"
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

# P54g (pin): a session-owned appended line (`# fe:session-theme` tag) means the block never had a
# `theme =` of its own — there is no shared dev id in this file to protect
FG54="$CPTD/toml/tagged.toml"
printf '[environments.development]\nstore = "acme-dev"\ntheme = "555" # fe:session-theme\npassword = "shptka_fixture1234"\n' > "$FG54"
rc=0; L="$TMP/cpt54g"; : > "$L"
run_cpt "$L" TOML_PATH="$FG54" -- refresh --theme 555 --no-build || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^theme_id=555$' "$O"; then ok
else bad P54g-tagged-line-no-dev-theme "rc=$rc out=$(tr '\n' ';' < "$O")"; fi

# P54h: the tag is matched by line shape — a comment merely mentioning it does not disarm the guard
FT54="$CPTD/toml/tagcomment.toml"
printf '[environments.development]\n# see fe:session-theme in the docs\nstore = "acme-dev"\ntheme = "111"\npassword = "shptka_fixture1234"\n' > "$FT54"
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
if [ "$rc" -eq 0 ] && grep -q '^superseded_theme_id=333$' "$O" && grep -q 'fe:superseded' "$FI54"; then ok
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

# P54j (bug): the tagged branch — a theme-less dev block gets `theme = "555" # fe:session-theme`
# appended while the settings source (777) comes from another block; the tag disarmed the guard
FJ54="$CPTD/toml/prodfirst.toml"
printf '[environments.production]\nstore = "acme-dev"\ntheme = "777"\n\n[environments.dev]\nstore = "acme-dev"\npassword = "shptka_fixture1234"\n' > "$FJ54"
rc=0; L="$TMP/cpt54j"; : > "$L"
run_cpt "$L" TOML_PATH="$FJ54" -- pin --theme 555 || rc=$?
if [ "$rc" -eq 0 ] && grep -q 'theme = "555" # fe:session-theme' "$FJ54"; then ok
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
printf '[environments.development]\nstore = "acme-dev"\n# theme = "555" # fe:session-theme\ntheme = "111"\npassword = "shptka_fixture1234"\n' > "$FK54"
rc=0; L="$TMP/cpt54k"; : > "$L"
run_cpt "$L" TOML_PATH="$FK54" -- refresh --theme 111 --no-build || rc=$?
if [ "$rc" -ne 0 ] && grep -q '^error=dev_theme_write_refused theme=111' "$O" \
   && [ "$(cpt_calls 'theme push' "$L")" -eq 0 ]; then ok
else bad P54k-commented-tag-does-not-disarm "rc=$rc out=$(head -c 200 "$O" | tr '\n' ' ')"; fi

# P54l: a marker whose value is a NAME still marks the block as pinned — the line below it is the
# session theme, not a fallback to "the settings source is the dev theme"
FL54="$CPTD/toml/namemarker.toml"
printf '[environments.development]\nstore = "acme-dev"\n# theme = "Kever Dev"  # fe:superseded\ntheme = "555"\npassword = "shptka_fixture1234"\n' > "$FL54"
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
# 2026-07-26, twice, at 0% upload. FE_CPT_THROTTLE_WAITS="0 0" makes the retry pauses instant.

# P24 (bug): a code push that throttles twice then clears must succeed via the retry loop —
# without it the run dies on the FIRST 429 and (on create) orphans the server-side theme
rc=0; L="$TMP/cpt24"; : > "$L"; CNT="$TMP/cpt24.count"; rm -f "$CNT"
run_cpt "$L" FE_CPT_THROTTLE_WAITS="0 0" FAKE_PUSH_THROTTLE_N=2 FAKE_PUSH_COUNT="$CNT" \
  -- create --name "PREVIEW-T" --no-build || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^theme_id=222$' "$O" \
   && [ "$(grep -c 'argv=theme push.*--unpublished' "$L")" -eq 3 ]; then ok
else bad P24-throttle-retry-succeeds "rc=$rc out=$(head -c 160 "$O" | tr '\n' ' ') pushes=$(grep -c 'argv=theme push' "$L")"; fi

# P25 (bug): a throttle that HOLDS through the retries, after the CLI already created the theme
# server-side (`--unpublished` creates first, uploads second) — the run must name the throttle as
# the cause, find the theme it created (fresh list vs the pre-push snapshot) and delete it, or a
# slot burns toward the 20/100 cap with no `created_theme=` line
rc=0; L="$TMP/cpt25"; : > "$L"; MK="$TMP/cpt25.mark"; rm -f "$MK"
run_cpt "$L" FE_CPT_THROTTLE_WAITS="0" FAKE_PUSH_CODE_FAIL='│  Throttled' FAKE_LIST_MARK="$MK" \
  FAKE_LIST='[{"id":111,"name":"[DEV] Kever","role":"development"},{"id":999,"name":"Live Theme","role":"live"}]' \
  FAKE_LIST2='[{"id":111,"name":"[DEV] Kever","role":"development"},{"id":999,"name":"Live Theme","role":"live"},{"id":777,"name":"PREVIEW-T","role":"unpublished"}]' \
  -- create --name "PREVIEW-T" --no-build || rc=$?
if [ "$rc" -ne 0 ] && grep -q 'error=push_code_failed' "$O" && grep -q 'cause=throttled' "$O" \
   && grep -q '^created_theme=777$' "$O" && grep -q '^created_theme_deleted=yes$' "$O" \
   && grep -q 'argv=theme delete.*777' "$L"; then ok
else bad P25-throttled-orphan-reaped "rc=$rc out=$(head -c 200 "$O" | tr '\n' ' ') calls=$(tr '\n' ';' < "$L")"; fi

# P25b (pin): only the id that APPEARED across the push is this run's — a pre-existing theme wearing
# the same name is never deleted (Shopify allows duplicate names)
rc=0; L="$TMP/cpt25b"; : > "$L"; MK="$TMP/cpt25b.mark"; rm -f "$MK"
run_cpt "$L" FE_CPT_THROTTLE_WAITS="0" FAKE_PUSH_CODE_FAIL='│  Throttled' FAKE_LIST_MARK="$MK" \
  FAKE_LIST='[{"id":111,"name":"[DEV] Kever","role":"development"},{"id":600,"name":"PREVIEW-T","role":"unpublished"}]' \
  FAKE_LIST2='[{"id":111,"name":"[DEV] Kever","role":"development"},{"id":600,"name":"PREVIEW-T","role":"unpublished"},{"id":777,"name":"PREVIEW-T","role":"unpublished"}]' \
  -- create --name "PREVIEW-T" --no-build || rc=$?
if [ "$rc" -ne 0 ] && grep -q '^created_theme=777$' "$O" \
   && grep -q 'argv=theme delete.*777' "$L" && ! grep -q 'argv=theme delete.*600' "$L"; then ok
else bad P25b-preexisting-name-kept "rc=$rc out=$(head -c 200 "$O" | tr '\n' ' ') calls=$(tr '\n' ';' < "$L")"; fi

# P25c (bug): attribution is "appeared ACROSS THE PUSH", and the snapshot is only worth that if it
# is taken across the push. The overlay-source check now loads the listing before the build, so a
# cached snapshot would be minutes stale — old enough for a parallel run to have created a theme
# wearing this name, which would then read as this run's orphan and be hard-deleted.
rc=0; L="$TMP/cpt25c"; : > "$L"; MK="$TMP/cpt25c.mark"; rm -f "$MK"
run_cpt "$L" FE_CPT_THROTTLE_WAITS="" FAKE_PUSH_CODE_FAIL='Error: socket hang up' FAKE_LIST_MARK="$MK" \
  FAKE_LIST='[{"id":111,"name":"[DEV] Kever","role":"development"},{"id":999,"name":"Live Theme","role":"live"}]' \
  FAKE_LIST2='[{"id":111,"name":"[DEV] Kever","role":"development"},{"id":999,"name":"Live Theme","role":"live"},{"id":777,"name":"PREVIEW-T","role":"unpublished"}]' \
  -- create --name "PREVIEW-T" --build-script dropmark || rc=$?
if [ "$rc" -ne 0 ] && grep -q 'error=push_code_failed' "$O" && ! grep -q '^created_theme' "$O" \
   && ! grep -q 'argv=theme delete' "$L"; then ok
else bad P25c-concurrent-theme-kept "rc=$rc out=$(head -c 200 "$O" | tr '\n' ' ') calls=$(tr '\n' ';' < "$L")"; fi

# P26 (pin): a throttle that fired BEFORE the server-side create (no new id in the fresh list) must
# not invent a `created_theme=` claim or delete anything
rc=0; L="$TMP/cpt26"; : > "$L"
run_cpt "$L" FE_CPT_THROTTLE_WAITS="0" FAKE_PUSH_CODE_FAIL='│  Throttled' \
  -- create --name "PREVIEW-T" --no-build || rc=$?
if [ "$rc" -ne 0 ] && grep -q 'error=push_code_failed' "$O" && grep -q 'cause=throttled' "$O" \
   && ! grep -q 'created_theme=' "$O" && [ "$(cpt_calls 'theme delete' "$L")" -eq 0 ]; then ok
else bad P26-no-create-no-reap "rc=$rc out=$(head -c 200 "$O" | tr '\n' ' ') calls=$(tr '\n' ';' < "$L")"; fi

# P27 (bug): the overlay push throttling through its retries reports cause=throttled (the actionable
# hint), not the box-drawing frame line the generic `error|fail` grep fishes out of the CLI's output
rc=0; L="$TMP/cpt27"; : > "$L"
run_cpt "$L" FE_CPT_THROTTLE_WAITS="0" FAKE_PUSH_ONLY_FAIL='│  Throttled' \
  -- create --name "PREVIEW-T" --no-build || rc=$?
if [ "$rc" -ne 0 ] && grep -q 'error=overlay_push_failed' "$O" && grep -q 'cause=throttled' "$O" \
   && grep -q '^created_theme_deleted=yes$' "$O"; then ok
else bad P27-overlay-throttle-cause "rc=$rc out=$(head -c 200 "$O" | tr '\n' ' ')"; fi

# P28 (pin): refresh shares the retry loop — one throttled 429, then success on the second attempt
rc=0; L="$TMP/cpt28"; : > "$L"; CNT="$TMP/cpt28.count"; rm -f "$CNT"
run_cpt "$L" FE_CPT_THROTTLE_WAITS="0 0" FAKE_PUSH_THROTTLE_N=1 FAKE_PUSH_COUNT="$CNT" \
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
run_cpt "$L" FE_CPT_OVERLAY_VERIFY_WAIT=0 FAKE_PULL_TPL=1 FAKE_VERIFY_DROP="templates/product.json" \
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
run_cpt "$L" FE_CPT_OVERLAY_VERIFY_WAIT=0 FAKE_PULL_TPL=1 FAKE_VERIFY_DROP="templates/product.json" \
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

# P53e (pin): FE_CPT_OVERLAY_VERIFY=0 skips — no read-back pull at all, overlay=skipped
rc=0; L="$TMP/cpt53e"; : > "$L"
run_cpt "$L" FE_CPT_OVERLAY_VERIFY=0 FAKE_PULL_TPL=1 FAKE_VERIFY_DROP="templates/product.json" \
  -- create --name "PREVIEW-V" --no-build || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^overlay=skipped$' "$O" && ! grep -q 'warn=overlay' "$O" \
   && [ "$(cpt_calls 'theme pull' "$L")" -eq 1 ]; then ok
else bad P53e-verify-kill-switch "rc=$rc out=$(tr '\n' ';' < "$O") pulls=$(cpt_calls 'theme pull' "$L")"; fi

# P53f (bug): the REAL input shape — Shopify stamps a /*…*/ banner onto every *.json it serves, so
# a jq that is handed the file as-is always fails and the type read silently degrades to the raw
# grep. Banner stripped, the same drop still names exactly the one alien type.
rc=0; L="$TMP/cpt53f"; : > "$L"
run_cpt "$L" FE_CPT_OVERLAY_VERIFY_WAIT=0 FAKE_PULL_BANNER=1 FAKE_PULL_TPL=1 \
  FAKE_VERIFY_DROP="templates/product.json" -- create --name "PREVIEW-V" --no-build || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^overlay=partial$' "$O" \
   && grep -q '^warn=overlay_file_dropped file=templates/product.json unknown_types=delivery_banner$' "$O"; then ok
else bad P53f-banner-still-typed "rc=$rc out=$(tr '\n' ';' < "$O")"; fi

# P53g (bug): a malformed wait falls back to the default instead of handing `sleep` an argument it
# refuses — under `set -e` that aborted the run AFTER the theme existed, so stdout carried neither
# the id nor an error=. `1.2.3` passes a bytes-only filter, which is why it is the fixture here;
# this is the one row in the section that pays the fallback pause.
rc=0; L="$TMP/cpt53g"; : > "$L"
run_cpt "$L" FE_CPT_OVERLAY_VERIFY_WAIT=1.2.3 FAKE_PULL_TPL=1 \
  FAKE_VERIFY_DROP="templates/product.json" -- create --name "PREVIEW-V" --no-build || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^theme_id=222$' "$O" && grep -q '^overlay=partial$' "$O"; then ok
else bad P53g-malformed-wait "rc=$rc out=$(tr '\n' ';' < "$O") err=$(head -c 200 "$E" | tr '\n' ' ')"; fi

# P53h (pin): a dropped file with no section/block types to name gets the BARE warn line —
# unknown_types= is omitted, never printed empty, so a reader is not told to hunt a phantom type
rc=0; L="$TMP/cpt53h"; : > "$L"
run_cpt "$L" FE_CPT_OVERLAY_VERIFY_WAIT=0 FAKE_VERIFY_DROP="config/settings_data.json" \
  -- create --name "PREVIEW-V" --no-build || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^overlay=partial$' "$O" \
   && grep -q '^warn=overlay_file_dropped file=config/settings_data.json$' "$O"; then ok
else bad P53h-bare-warn "rc=$rc out=$(tr '\n' ';' < "$O")"; fi

# P53i (bug): the read-back runs on the --reuse path too — the drop is likeliest there, and a
# reused theme must still not be deleted over a warning
rc=0; L="$TMP/cpt53i"; : > "$L"
run_cpt "$L" FAKE_LIST='[{"id":111,"name":"[DEV] Kever","role":"development"},{"id":555,"name":"PREVIEW-V","role":"unpublished"}]' \
  FE_CPT_OVERLAY_VERIFY_WAIT=0 FAKE_PULL_TPL=1 FAKE_VERIFY_DROP="templates/product.json" \
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
run_cpt "$L" FAKE_PULL_EMPTY=1 -- create --name "[ABC-1] Kever" --reuse --no-build || rc=$?
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
run_cpt "$L" FE_CPT_THROTTLE_WAITS="0" FAKE_PUSH_CODE_FAIL='│  Throttled' FAKE_LIST_MARK="$MK" FAKE_DELETE_FAIL=1 \
  FAKE_LIST='[{"id":111,"name":"[DEV] Kever","role":"development"},{"id":999,"name":"Live Theme","role":"live"}]' \
  FAKE_LIST2='[{"id":111,"name":"[DEV] Kever","role":"development"},{"id":999,"name":"Live Theme","role":"live"},{"id":777,"name":"PREVIEW-T","role":"unpublished"}]' \
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
PIN_LIST='[{"id":111,"name":"[DEV] Kever","role":"development"},{"id":222,"name":"[ABC-1] session","role":"unpublished"},{"id":999,"name":"Live Theme","role":"live"}]'
fhash() { cksum < "$1"; }

# P29 (pin): the FIRST uncommented `theme =` line takes the session id — the VALUE only, with the
# line's spacing and trailing comment intact — and nothing is pushed. The config's own path is
# not echoed back: the caller passed it in. The file two lines down holds the Theme Access
# token: it must survive untouched and never reach the output.
F="$CPTD/toml/pin-basic.toml"
printf '# session config\n[environments.development]\nstore = "acme-dev"\ntheme = "111"   # dev theme\npassword = "shptka_fixture1234"\n' > "$F"
rc=0; L="$TMP/cpt29"; : > "$L"
run_cpt "$L" TOML_PATH="$F" FAKE_LIST="$PIN_LIST" -- pin --theme 222 || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^theme_id=222$' "$O" && grep -q '^pin=rewritten$' "$O" \
   && grep -q '^pin_env=development$' "$O" \
   && grep -q '^commented_dupes=0$' "$O" && ! grep -q '^pinned_toml=' "$O" \
   && grep -qx 'theme = "222"   # dev theme' "$F" \
   && [ "$(grep -c 'shptka_fixture1234' "$F")" -eq 1 ] && ! grep -q 'shptka' "$O" "$E" \
   && [ "$(cpt_calls 'theme push' "$L")" -eq 0 ] && [ "$(cpt_calls 'theme pull' "$L")" -eq 0 ]; then ok
else bad P29-pin-rewrites-first "rc=$rc out=$(tr '\n' ';' < "$O") toml=$(grep -v password "$F" | tr '\n' ';')"; fi

# P29b (bug): the id the pin REPLACED is preserved, commented and tagged, right above the pinned
# line — this file is gitignored, so overwriting the shared dev theme id in place would leave it
# recorded nowhere and a mis-pin unrecoverable without hunting it down in the Shopify admin. The
# id is reported too (`superseded_theme_id=`), so the caller can note it.
if grep -qx '# theme = "111"   # dev theme  # fe:superseded' "$F" \
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
   && grep -qx '# theme = "111"  # fe:superseded' "$FM" \
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
   && grep -qx 'theme = "222"' "$FAM" && grep -qx '# theme = "444"  # fe:superseded' "$FAM"; then ok
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
# `# fe:session-theme` tag: it is session-owned (nothing was superseded), and the tag is what
# lets worktree-theme.sh's unpin delete it and restore the original no-theme state.
FA="$CPTD/toml/pin-append.toml"
printf '[environments.development]\nstore = "acme-dev"\n# theme = "111"\npassword = "shptka_fixture1234"\n' > "$FA"
rc=0; L="$TMP/cpt31"; : > "$L"
run_cpt "$L" TOML_PATH="$FA" FAKE_LIST="$PIN_LIST" -- pin --theme 222 || rc=$?
WANT31='[environments.development]
store = "acme-dev"
theme = "222" # fe:session-theme
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
theme = "222" # fe:session-theme
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
theme = "222" # fe:session-theme
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
if [ "$(grep -c 'fe:superseded' "$FM")" -eq 1 ] \
   && grep -qx '# theme = "111"  # fe:superseded' "$FM"; then ok
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
   && [ "$(grep -n '^warn=pin_unvetted$' "$O" | cut -d: -f1)" -lt "$(grep -n '^pin=' "$O" | head -1 | cut -d: -f1)" ]; then ok
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
   && grep -q 'theme = "222"' "$FC" && grep -q '# theme = "111"  # fe:superseded' "$FC"; then ok
else bad P38-pin-crlf "rc=$rc cr=$CR38 lf=$LF38 out=$(tr '\n' ';' < "$O")"; fi

# P39 (pin): the quoting style is the developer's — a single-quoted value stays single-quoted,
# so a re-pin of the same id can stay a byte-for-byte no-op (P32) whatever the file looks like
FQ="$CPTD/toml/pin-quote.toml"
printf "[environments.development]\nstore = 'acme-dev'\ntheme = '111'\npassword = 'shptka_fixture1234'\n" > "$FQ"
rc=0; L="$TMP/cpt39"; : > "$L"
run_cpt "$L" TOML_PATH="$FQ" FAKE_LIST="$PIN_LIST" -- pin --theme 222 || rc=$?
if [ "$rc" -eq 0 ] && grep -qx "theme = '222'" "$FQ" \
   && grep -qx "# theme = '111'  # fe:superseded" "$FQ"; then ok
else bad P39-pin-single-quote "rc=$rc toml=$(grep -v password "$FQ" | tr '\n' ';')"; fi

# P39b (pin): and a BARE value stays bare, with its trailing comment where it was
FB2="$CPTD/toml/pin-bare.toml"
printf '[environments.development]\nstore = acme-dev\ntheme = 111  # dev\npassword = "shptka_fixture1234"\n' > "$FB2"
rc=0; L="$TMP/cpt39b"; : > "$L"
run_cpt "$L" TOML_PATH="$FB2" FAKE_LIST="$PIN_LIST" -- pin --theme 222 || rc=$?
if [ "$rc" -eq 0 ] && grep -qx 'theme = 222  # dev' "$FB2" \
   && grep -qx '# theme = 111  # dev  # fe:superseded' "$FB2"; then ok
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
   && [ "$(grep -n '^theme_id=' "$O" | cut -d: -f1)" -lt "$(grep -n '^pin=' "$O" | head -1 | cut -d: -f1)" ]; then ok
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

# P48 (blocker): the appended pin line is exactly `theme = "<id>" # fe:session-theme` — and a
# same-id re-pin on the tagged line stays a byte-for-byte no-op (the tag must not break the
# idempotence P32 established for the rewrite path)
F48="$CPTD/toml/pin-tag.toml"
printf '[environments.development]\nstore = "acme-dev"\npassword = "shptka_fixture1234"\n' > "$F48"
rc=0; L="$TMP/cpt48"; : > "$L"
run_cpt "$L" TOML_PATH="$F48" FAKE_LIST="$PIN_LIST" -- pin --theme 222 || rc=$?
H48="$(fhash "$F48")"
rc2=0; run_cpt "$L" TOML_PATH="$F48" FAKE_LIST="$PIN_LIST" -- pin --theme 222 || rc2=$?
if [ "$rc" -eq 0 ] && [ "$rc2" -eq 0 ] && grep -q '^pin=unchanged$' "$O" \
   && grep -qx 'theme = "222" # fe:session-theme' "$F48" \
   && ! grep -q 'fe:superseded' "$F48" && [ "$(fhash "$F48")" = "$H48" ]; then ok
else bad P48-append-session-tag "rc=$rc rc2=$rc2 out=$(tr '\n' ';' < "$O") toml=$(grep -v password "$F48" | tr '\n' ';')"; fi

# P48b (blocker): re-pinning a DIFFERENT id onto a tagged line swaps the value, KEEPS the tag and
# writes NO fe:superseded marker — the line is session-owned, the block's original state had no
# `theme =` at all, so there is nothing to supersede and unpin must still simply delete the line
rc=0; L="$TMP/cpt48b"; : > "$L"
run_cpt "$L" TOML_PATH="$F48" FAKE_LIST="$PIN_LIST" -- pin --theme 111 || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^pin=rewritten$' "$O" \
   && grep -qx 'theme = "111" # fe:session-theme' "$F48" \
   && ! grep -q 'fe:superseded' "$F48"; then ok
else bad P48b-repin-keeps-tag-no-marker "rc=$rc out=$(tr '\n' ';' < "$O") toml=$(grep -v password "$F48" | tr '\n' ';')"; fi

# P49 (bug): only a REAL marker line (`# theme = … # fe:superseded`) counts as "this block is
# already pinned" — a stray comment merely containing the string used to suppress the marker, so
# a real pin overwrote the dev theme id with NO commented copy left to restore
F49="$CPTD/toml/pin-stray.toml"
printf '[environments.development]\nstore = "acme-dev"\n# NB fe:superseded markers are plugin-managed\ntheme = "111"\npassword = "shptka_fixture1234"\n' > "$F49"
rc=0; L="$TMP/cpt49"; : > "$L"
run_cpt "$L" TOML_PATH="$F49" FAKE_LIST="$PIN_LIST" -- pin --theme 222 || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^superseded_theme_id=111$' "$O" \
   && grep -qx '# theme = "111"  # fe:superseded' "$F49" \
   && grep -qx '# NB fe:superseded markers are plugin-managed' "$F49" \
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
   && grep -qx '# theme = "999001"  # fe:superseded' "$F50"; then ok
else bad P50-single-nondev-block "rc=$rc rc2=$rc2 untouched=$UNTOUCHED50 out=$(printf '%s' "$OUT50" | head -c 160 | tr '\n' ' ') toml=$(grep -v password "$F50" | tr '\n' ';')"; fi

# P51 (pin): a toml with no [environments.*] at all pins the top-level keys and says so —
# pin_env=- is the sentinel a caller can trust (no block name can ever be `-`)
F51="$CPTD/toml/pin-toplevel.toml"
printf 'store = "acme-dev"\ntheme = "111"\npassword = "shptka_fixture1234"\n' > "$F51"
rc=0; L="$TMP/cpt51"; : > "$L"
run_cpt "$L" TOML_PATH="$F51" FAKE_LIST="$PIN_LIST" -- pin --theme 222 || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^pin=rewritten$' "$O" && grep -q '^pin_env=-$' "$O" \
   && grep -qx 'theme = "222"' "$F51" \
   && grep -qx '# theme = "111"  # fe:superseded' "$F51"; then ok
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
   && grep -qx '# theme = "111"  # fe:superseded' "$F51B"; then ok
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
   && [ "$(ls -a "$PRO" | grep -c 'fe-pin')" -eq 0 ]; then ok
else bad P43-create-pin-failure-nonfatal "rc=$rc out=$(tr '\n' ';' < "$O") left=$(ls -a "$PRO" | tr '\n' ' ')"; fi

# P44 (pin): standalone `pin` has nothing else to report, so the same write failure IS the
# result — it exits non-zero with error=pin_toml_failed and leaves the config untouched
chmod 555 "$PRO"
rc=0; L="$TMP/cpt44"; : > "$L"
run_cpt "$L" TOML_PATH="$FRO" FAKE_LIST="$PIN_LIST" -- pin --theme 222 || rc=$?
chmod 755 "$PRO"
if [ "$rc" -ne 0 ] && grep -q 'error=pin_toml_failed' "$O" && [ "$(fhash "$FRO")" = "$HRO" ] \
   && [ "$(ls -a "$PRO" | grep -c 'fe-pin')" -eq 0 ]; then ok
else bad P44-pin-write-failure "rc=$rc out=$(head -c 200 "$O" | tr '\n' ' ') left=$(ls -a "$PRO" | tr '\n' ' ')"; fi

# P45 (pin): the rewrite stages its temp file NEXT TO the config (same dir = an atomic rename
# that cannot cross a filesystem), so every run must take that dot-file away with it
if [ "$(ls -a "$CPTD/toml" | grep -c 'fe-pin')" -eq 0 ]; then ok
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

# ------------------------------- create-preview-theme.sh multi-environment READS --
# A multi-environment toml holds one store, token and theme id PER BLOCK. The store, the dev theme
# id and the Theme Access token used to be the first uncommented match in the WHOLE file — read
# before --env was even parsed — so `--env dev` listed and pushed against `[environments.production]`
# with the PRODUCTION token and then pinned the id into the dev block. The read now resolves the
# same block the pin does; the cases below assert WHICH store and token the CLI was handed.
ENV_TWO='[environments.production]
store = "store-a"
password = "shptka_prodAAA"
theme = "111"

[environments.dev]
store = "store-b"
password = "shptka_devBBB"
theme = "444"
'
# production + staging, two DIFFERENT stores and neither named dev/development
ENV_DIFF='[environments.production]
store = "store-a"
password = "shptka_prodAAA"
theme = "111"

[environments.staging]
store = "store-c"
password = "shptka_stgCCC"
theme = "333"
'
# the same two blocks naming ONE store: no choice can target the wrong one, so reading may stay
# file-ordered — the pin, which still cannot tell which block the dev server reads, may not
ENV_SAME='[environments.production]
store = "store-a"
password = "shptka_prodAAA"
theme = "111"

[environments.staging]
store = "store-a"
theme = "333"
'
ENV_LIST='[{"id":111,"name":"[PROD] theme","role":"unpublished"},{"id":333,"name":"[STG] theme","role":"unpublished"},{"id":222,"name":"[ABC-1] session","role":"unpublished"},{"id":444,"name":"[DEV] Kever","role":"development"},{"id":555,"name":"[ABC-2] session","role":"unpublished"},{"id":999,"name":"Live Theme","role":"live"}]'
env_toml() { printf '%s' "$2" > "$CPTD/toml/$1.toml"; printf '%s' "$CPTD/toml/$1.toml"; }

# P59 (blocker): `pin --theme <id> --env dev` vets the id against the DEV block's store with the DEV
# block's token, and the production block comes out byte-for-byte unchanged
F59="$(env_toml env-two-pin "$ENV_TWO")"
PROD59="$(sed -n '1,4p' "$F59" | cksum)"
rc=0; L="$TMP/cpt59"; : > "$L"
run_cpt "$L" TOML_PATH="$F59" FAKE_LIST="$ENV_LIST" -- pin --theme 222 --env dev || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^argv=theme list --store store-b --json --no-color$' "$L" \
   && grep -q '^token=shptka_devBBB$' "$L" && ! grep -q 'shptka_prodAAA' "$L" \
   && grep -q '^store=store-b$' "$O" && grep -q '^env=dev$' "$O" && grep -q '^pin_env=dev$' "$O" \
   && [ "$(sed -n '1,4p' "$F59" | cksum)" = "$PROD59" ] \
   && grep -q '^superseded_theme_id=444$' "$O" \
   && [ "$(grep -c '^theme = "222"$' "$F59")" -eq 1 ]; then ok
else bad P59-pin-env-reads-that-block "rc=$rc out=$(tr '\n' ';' < "$O") log=$(grep -v token "$L" | tr '\n' ';') toml=$(grep -v password "$F59" | tr '\n' ';')"; fi

# P59b (blocker): the same for `create --pin-toml --env dev` — the push itself must carry the dev
# block's store and token, or the preview theme is created on the production store
F59B="$(env_toml env-two-create "$ENV_TWO")"
rc=0; L="$TMP/cpt59b"; : > "$L"
run_cpt "$L" TOML_PATH="$F59B" FAKE_LIST="$ENV_LIST" -- create --name "PREVIEW-ENV" --no-build --pin-toml --env dev || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^argv=theme push --store store-b --unpublished --theme PREVIEW-ENV .*--json$' "$L" \
   && grep -q '^token=shptka_devBBB$' "$L" && ! grep -q 'shptka_prodAAA' "$L" \
   && grep -q '^theme_id=222$' "$O" && grep -q '^env=dev$' "$O" && grep -q '^pin_env=dev$' "$O" \
   && grep -q '^pin=rewritten$' "$O" \
   && grep -q '^theme = "111"$' "$F59B" && [ "$(grep -c '^theme = "222"$' "$F59B")" -eq 1 ]; then ok
else bad P59b-create-env-pushes-that-store "rc=$rc out=$(tr '\n' ';' < "$O") log=$(grep -v token "$L" | tr '\n' ';') toml=$(grep -v password "$F59B" | tr '\n' ';')"; fi

# P59c (blocker): and for `refresh --pin-toml --env production` — the named block is the LAST one
# here, so a reader that still resolved by file order could not pass this one either
F59C="$(env_toml env-two-refresh '[environments.dev]
store = "store-b"
password = "shptka_devBBB"
theme = "444"

[environments.production]
store = "store-a"
password = "shptka_prodAAA"
theme = "111"
')"
rc=0; L="$TMP/cpt59c"; : > "$L"
run_cpt "$L" TOML_PATH="$F59C" FAKE_LIST="$ENV_LIST" -- refresh --theme 555 --no-build --pin-toml --env production || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^argv=theme push --store store-a --theme 555 .*--json$' "$L" \
   && grep -q '^token=shptka_prodAAA$' "$L" && ! grep -q 'shptka_devBBB' "$L" \
   && grep -q '^env=production$' "$O" && grep -q '^pin_env=production$' "$O" \
   && grep -q '^superseded_theme_id=111$' "$O" \
   && grep -q '^theme = "444"$' "$F59C" && [ "$(grep -c '^theme = "555"$' "$F59C")" -eq 1 ]; then ok
else bad P59c-refresh-env-production "rc=$rc out=$(tr '\n' ';' < "$O") log=$(grep -v token "$L" | tr '\n' ';') toml=$(grep -v password "$F59C" | tr '\n' ';')"; fi

# P59d: with no --env at all the default resolution is the pin's — `dev`, by name — so the store
# reported and listed against is the dev block's, not the file's first
F59D="$(env_toml env-two-info "$ENV_TWO")"
rc=0; L="$TMP/cpt59d"; : > "$L"
run_cpt "$L" TOML_PATH="$F59D" FAKE_LIST="$ENV_LIST" -- info || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^store=store-b$' "$O" && grep -q '^env=dev$' "$O" \
   && grep -q '^dev_theme_id=444$' "$O" \
   && grep -q '^argv=theme list --store store-b --json --no-color$' "$L"; then ok
else bad P59d-default-picks-dev "rc=$rc out=$(tr '\n' ';' < "$O") log=$(grep -v token "$L" | tr '\n' ';')"; fi

# P59e (blocker): different stores and no block named dev/development — the run is refused BEFORE
# the CLI is touched (a wrong-store push cannot be taken back) and nothing is written
F59E="$(env_toml env-diff "$ENV_DIFF")"
H59E="$(fhash "$F59E")"
rc=0; L="$TMP/cpt59e"; : > "$L"
run_cpt "$L" TOML_PATH="$F59E" FAKE_LIST="$ENV_LIST" -- refresh --theme 555 --no-build || rc=$?
OUT59E="$(cat "$O")"
rc2=0; L2="$TMP/cpt59e2"; : > "$L2"
run_cpt "$L2" TOML_PATH="$F59E" FAKE_LIST="$ENV_LIST" -- info || rc2=$?
OUT59E2="$(cat "$O")"
if [ "$rc" -ne 0 ] && [ "$rc2" -ne 0 ] \
   && printf '%s' "$OUT59E" | grep -q '^error=ambiguous_env envs=production staging ' \
   && grep -q '^error=ambiguous_env' "$O" \
   && [ ! -s "$L" ] && [ ! -s "$L2" ] && [ "$(fhash "$F59E")" = "$H59E" ]; then ok
else bad P59e-ambiguous-refused-before-cli "rc=$rc rc2=$rc2 out=$(printf '%s' "$OUT59E" | head -c 200 | tr '\n' ' ') calls=$(tr '\n' ';' < "$L")$(tr '\n' ';' < "$L2")"; fi

# P59e2 (bug): the escape hatch the refusal names has to be one THIS invocation can take —
# `re-run with --env <name>` on a `refresh` without --pin-toml is refused by the very next run
# (`--env requires --pin-toml`), so the message named a loop, not a fix
if printf '%s' "$OUT59E" | grep -q 'SHOPIFY_FLAG_ENVIRONMENT=<name>' \
   && printf '%s' "$OUT59E" | grep -q -- '--pin-toml --env <name>' \
   && printf '%s' "$OUT59E2" | grep -q 'SHOPIFY_FLAG_ENVIRONMENT=<name> (this subcommand takes no --env)'; then ok
else bad P59e2-fix-is-takeable "refresh=$(printf '%s' "$OUT59E" | head -c 260 | tr '\n' ' ') info=$(printf '%s' "$OUT59E2" | head -c 200 | tr '\n' ' ')"; fi

# P59e3: and each named remedy actually runs — the env var for a plain refresh, `--pin-toml --env`
# for the pinning one; both on the file that just refused
rc=0; L="$TMP/cpt59e3"; : > "$L"
run_cpt "$L" TOML_PATH="$F59E" SHOPIFY_FLAG_ENVIRONMENT=staging FAKE_LIST="$ENV_LIST" -- refresh --theme 555 --no-build || rc=$?
rc2=0; L2="$TMP/cpt59e4"; : > "$L2"
run_cpt "$L2" TOML_PATH="$F59E" FAKE_LIST="$ENV_LIST" -- refresh --theme 555 --no-build --pin-toml --env production || rc2=$?
if [ "$rc" -eq 0 ] && grep -q '^argv=theme push --store store-c --theme 555 ' "$L" \
   && grep -q '^token=shptka_stgCCC$' "$L" \
   && [ "$rc2" -eq 0 ] && grep -q '^argv=theme push --store store-a --theme 555 ' "$L2" \
   && grep -q '^pin_env=production$' "$O"; then ok
else bad P59e3-named-remedy-runs "rc=$rc rc2=$rc2 log=$(grep -v token "$L" | tr '\n' ';') log2=$(grep -v token "$L2" | tr '\n' ';') out=$(tr '\n' ';' < "$O")"; fi

# P59f (pin): the same two blocks naming ONE store keep working exactly as they did — file-ordered
# reads (`env=*`) — while the PIN still refuses: which block `shopify theme dev` reads is unknown,
# and only the pin has to answer that
F59F="$(env_toml env-same "$ENV_SAME")"
H59F="$(fhash "$F59F")"
rc=0; L="$TMP/cpt59f"; : > "$L"
run_cpt "$L" TOML_PATH="$F59F" FAKE_LIST="$ENV_LIST" -- info || rc=$?
rc2=0; L2="$TMP/cpt59f2"; : > "$L2"
run_cpt "$L2" TOML_PATH="$F59F" FAKE_LIST="$ENV_LIST" -- refresh --theme 555 --no-build || rc2=$?
if [ "$rc" -eq 0 ] && grep -q '^store=store-a$' "$O" && grep -q '^env=\*$' "$O" \
   && [ "$rc2" -eq 0 ] && grep -q '^argv=theme push --store store-a --theme 555 ' "$L2" \
   && grep -q '^token=shptka_prodAAA$' "$L2"; then ok
else bad P59f-same-store-file-order "rc=$rc rc2=$rc2 out=$(tr '\n' ';' < "$O") log=$(grep -v token "$L2" | tr '\n' ';')"; fi
rc=0; L="$TMP/cpt59f3"; : > "$L"
run_cpt "$L" TOML_PATH="$F59F" FAKE_LIST="$ENV_LIST" -- pin --theme 222 || rc=$?
if [ "$rc" -ne 0 ] && grep -q 'error=ambiguous_env' "$O" && [ "$(fhash "$F59F")" = "$H59F" ]; then ok
else bad P59f2-same-store-pin-still-refused "rc=$rc out=$(head -c 200 "$O" | tr '\n' ' ')"; fi

# P59g: $SHOPIFY_FLAG_ENVIRONMENT is the block selector `shopify theme dev -e` reads, so it is the
# default here too — and an explicit --env still wins over it
F59G="$(env_toml env-two-flag "$ENV_TWO")"
rc=0; L="$TMP/cpt59g"; : > "$L"
run_cpt "$L" TOML_PATH="$F59G" SHOPIFY_FLAG_ENVIRONMENT=production FAKE_LIST="$ENV_LIST" -- info || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^store=store-a$' "$O" && grep -q '^env=production$' "$O" \
   && grep -q '^dev_theme_id=111$' "$O"; then ok
else bad P59g-flag-environment-default "rc=$rc out=$(tr '\n' ';' < "$O")"; fi
rc=0; L="$TMP/cpt59g2"; : > "$L"
run_cpt "$L" TOML_PATH="$F59G" SHOPIFY_FLAG_ENVIRONMENT=production FAKE_LIST="$ENV_LIST" -- pin --theme 222 --env dev || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^env=dev$' "$O" && grep -q '^pin_env=dev$' "$O" \
   && grep -q '^token=shptka_devBBB$' "$L" && ! grep -q 'shptka_prodAAA' "$L"; then ok
else bad P59g2-explicit-env-wins "rc=$rc out=$(tr '\n' ';' < "$O") log=$(grep -v token "$L" | tr '\n' ';')"; fi

# P59h: a block name that is not in the file is a typo, not an invitation to fall back to another
# block — refused before any CLI call, nothing written
F59H="$(env_toml env-two-typo "$ENV_TWO")"
H59H="$(fhash "$F59H")"
rc=0; L="$TMP/cpt59h"; : > "$L"
run_cpt "$L" TOML_PATH="$F59H" FAKE_LIST="$ENV_LIST" -- pin --theme 222 --env nosuch || rc=$?
if [ "$rc" -ne 0 ] && grep -q '^error=env_not_found env=nosuch ' "$O" \
   && grep -q 'production dev' "$O" && [ ! -s "$L" ] && [ "$(fhash "$F59H")" = "$H59H" ]; then ok
else bad P59h-env-not-found "rc=$rc out=$(head -c 200 "$O" | tr '\n' ' ') calls=$(tr '\n' ';' < "$L")"; fi

# P59i: top-level keys before the first header are what a bare `shopify theme dev` reads, so they
# win over a named block the file also carries (env=-)
F59I="$(env_toml env-toplevel 'store = "store-top"
theme = "444"
password = "shptka_topTTT"

[environments.production]
store = "store-a"
theme = "111"
password = "shptka_prodAAA"
')"
rc=0; L="$TMP/cpt59i"; : > "$L"
run_cpt "$L" TOML_PATH="$F59I" FAKE_LIST="$ENV_LIST" -- info || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^store=store-top$' "$O" && grep -q '^env=-$' "$O" \
   && grep -q '^dev_theme_id=444$' "$O" && grep -q '^token=shptka_topTTT$' "$L"; then ok
else bad P59i-toplevel-wins "rc=$rc out=$(tr '\n' ';' < "$O") log=$(grep -v token "$L" | tr '\n' ';')"; fi

# P59j (blocker): a block that carries no password of its own must not borrow another STORE's
# token — a Theme Access token is minted per store, so the borrowed one authenticates nothing here.
# Refused with the config error, before the CLI.
F59J="$(env_toml env-notoken '[environments.production]
store = "store-a"
password = "shptka_prodAAA"
theme = "111"

[environments.dev]
store = "store-b"
theme = "444"
')"
rc=0; L="$TMP/cpt59j"; : > "$L"
run_cpt "$L" TOML_PATH="$F59J" FAKE_LIST="$ENV_LIST" -- info || rc=$?
if [ "$rc" -ne 0 ] && grep -q '^error=no access token' "$O" && [ ! -s "$L" ]; then ok
else bad P59j-no-cross-store-token "rc=$rc out=$(head -c 200 "$O" | tr '\n' ' ') calls=$(tr '\n' ';' < "$L")"; fi

# P59k (blocker): the same for the TOP-LEVEL keys — a block that omits `password` must not borrow
# the store-a token sitting above the first header. The whole run (list, pull, two pushes) used to
# go out against store-b carrying store-a's Theme Access token.
F59K="$(env_toml env-topmix 'store = "store-a"
password = "shptka_topAAA"
theme = "111"

[environments.dev]
store = "store-b"
theme = "444"
')"
rc=0; L="$TMP/cpt59k"; : > "$L"
run_cpt "$L" TOML_PATH="$F59K" FAKE_LIST="$ENV_LIST" -- create --name "PREVIEW-TOPMIX" --no-build || rc=$?
if [ "$rc" -ne 0 ] && grep -q '^error=no access token' "$O" && [ ! -s "$L" ]; then ok
else bad P59k-no-toplevel-cross-store-token "rc=$rc out=$(head -c 200 "$O" | tr '\n' ' ') calls=$(grep -v token "$L" | tr '\n' ';') borrowed=$(grep -c 'shptka_topAAA' "$L" 2>/dev/null || true)"; fi

# P59m: $SHOPIFY_FLAG_ENVIRONMENT selects the block the pin WRITES, not only the one it reads —
# the two are one resolution, so an exported value redirects the rewrite into that block (here
# production, while a `dev` block exists) and leaves the other one byte-identical
F59M="$(env_toml env-two-flagpin "$ENV_TWO")"
DEV59M="$(printf '[environments.dev]\nstore = "store-b"\npassword = "shptka_devBBB"\ntheme = "444"\n' | cksum)"
rc=0; L="$TMP/cpt59m"; : > "$L"
run_cpt "$L" TOML_PATH="$F59M" SHOPIFY_FLAG_ENVIRONMENT=production FAKE_LIST="$ENV_LIST" -- pin --theme 222 || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^env=production$' "$O" && grep -q '^pin_env=production$' "$O" \
   && ! grep -q '^warn=pin_env_mismatch' "$O" \
   && grep -q '^superseded_theme_id=111$' "$O" \
   && grep -q 'fe:superseded' "$F59M" \
   && [ "$(grep -c '^theme = "222"$' "$F59M")" -eq 1 ] \
   && [ "$(sed -n '/^\[environments.dev\]/,$p' "$F59M" | cksum)" = "$DEV59M" ]; then ok
else bad P59m-flag-environment-pin-target "rc=$rc out=$(tr '\n' ';' < "$O") toml=$(grep -v password "$F59M" | tr '\n' ';')"; fi

# P60 (bug): `--help` used to fall through to the unknown-command refusal — behind the CLI, jq and
# shopify.theme.toml checks, so "how do I call this" could not be answered outside a theme repo at
# all. It prints the header's own `# Usage:` block (two hand-maintained copies of a call shape are
# two copies free to disagree) from a directory with no toml, and touches nothing.
CPTH="$TMP/cpt-help"; mkdir -p "$CPTH"
CPTHH="$TMP/cpt-usage-header"
awk '/^# Usage:/ { f = 1 } f { if ($0 == "#" || $0 !~ /^#( |$)/) exit; sub(/^# ?/, ""); print }' \
  "$CPT" > "$CPTHH"
for ha in --help -h; do
  rc=0; L="$TMP/cpt60$ha"; : > "$L"
  run_cpt_at "$CPTH" "$CPTD/shim:$PATH" "$L" NO=1 -- "$ha" || rc=$?
  if [ "$rc" -eq 0 ] && [ ! -s "$E" ] && [ ! -s "$L" ] \
     && [ "$(wc -l < "$CPTHH" | tr -d ' ')" -eq 10 ] && sed '$d' "$O" | diff -q - "$CPTHH" >/dev/null; then ok
  else bad "P60-help[$ha]" "rc=$rc diff=$(sed '$d' "$O" | diff - "$CPTHH" | head -c 300 | tr '\n' ';') err=$(head -c 120 "$E" | tr '\n' ' ')"; fi
done
# P60b: the pointer line that follows it names where the full contract lives
if [ "$(tail -1 "$O")" = "Full contract: the header of $CPTD/cpt.sh" ]; then ok
else bad P60b-help-pointer "tail=$(tail -1 "$O")"; fi
# P60c: --help after a subcommand, and among its args, is still a usage question — the store is
# never touched and the mutating argv it rode in on is not carried out
for hc in "refresh --help" "pin -h" "refresh --theme 555 --help" "create --name X --pin-toml --help"; do
  rc=0; L="$TMP/cpt60c"; : > "$L"
  run_cpt "$L" NO=1 -- $hc || rc=$?
  if [ "$rc" -eq 0 ] && grep -q '^Usage:' "$O" && [ ! -s "$L" ]; then ok
  else bad "P60c-help[$hc]" "rc=$rc out=$(head -c 160 "$O" | tr '\n' ' ') log=$(tr '\n' ';' < "$L")"; fi
done
# P60d: a genuinely unknown command still gets its one-line refusal — now naming --help rather
# than reprinting the synopsis
rc=0; L="$TMP/cpt60d"; : > "$L"
run_cpt "$L" NO=1 -- bogus || rc=$?
if [ "$rc" -eq 1 ] \
   && grep -q "^error=unknown_command cmd='bogus' (use info|create|refresh|pin; --help prints usage)$" "$O" \
   && [ ! -s "$L" ]; then ok
else bad P60d-unknown-command-trailer "rc=$rc out=$(head -c 200 "$O" | tr '\n' ' ')"; fi
# …and so does no command at all
rc=0; L="$TMP/cpt60e"; : > "$L"
run_cpt "$L" NO=1 -- || rc=$?
if [ "$rc" -eq 1 ] && grep -q "^error=unknown_command cmd='' (use info|create|refresh|pin; --help prints usage)$" "$O"; then ok
else bad P60e-no-command-trailer "rc=$rc out=$(head -c 200 "$O" | tr '\n' ' ')"; fi
# P60f: the per-subcommand refusals are the ones a real typo hits, so they name the way out too
for uc in "refresh --thme 123" "create --name X --pintoml" "pin --theme 555 --nope"; do
  rc=0; L="$TMP/cpt60f"; : > "$L"
  run_cpt "$L" NO=1 -- $uc || rc=$?
  if [ "$rc" -eq 1 ] && grep -q '^error=unknown arg: --' "$O" && grep -q -- '--help prints usage' "$O" \
     && [ ! -s "$L" ]; then ok
  else bad "P60f-unknown-arg[$uc]" "rc=$rc out=$(head -c 200 "$O" | tr '\n' ' ')"; fi
done
# P60g (drift guard): every flag the three parse loops accept is spelled in that usage block — a
# `--foo)` arm added without a block update leaves --help lying about the accepted set. The floor
# fails an extraction that silently matched nothing.
CPTF="$(awk '/^ *while \[ \$# -gt 0 \]; do/ { f = 1 } f && /^ *done$/ { f = 0 } f && match($0, /^ *--[a-z-]+\)/) { s = substr($0, RSTART, RLENGTH); sub(/^ */, "", s); sub(/\)$/, "", s); print s }' "$CPT" | sort -u)"
missing=""; n=0
for fl in $CPTF; do n=$((n + 1)); grep -q -- "${fl}[^a-z-]" "$CPTHH" || missing="$missing $fl"; done
if [ "$n" -ge 9 ] && [ -z "$missing" ]; then ok
else bad P60g-usage-lists-flags "n=$n missing=[$missing]"; fi
# P60h: the scan is positional, which the header states outright — a flag VALUE of `-h` reads as a
# usage question, and the mutating argv it rode in on is not carried out
rc=0; L="$TMP/cpt60h"; : > "$L"
run_cpt "$L" NO=1 -- create --name -h --no-build || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^Usage:' "$O" && [ ! -s "$L" ] \
   && grep -q 'VALUE of `-h`' "$CPT"; then ok
else bad P60h-help-in-value-position "rc=$rc out=$(head -c 160 "$O" | tr '\n' ' ') log=$(tr '\n' ';' < "$L")"; fi

# P63: --store names the store to talk to (theme-json.sh's flag and precedence). A preview theme on a
# brand's OTHER regional store used to be unreachable: refresh listed the toml's store, died
# theme_not_found, and the caller fell back to a raw `shopify theme push` with no guard at all.
UK_LIST='[{"id":777,"name":"[ABC-1] UK","role":"unpublished"},{"id":888,"name":"Live UK","role":"live"}]'
# P63a: a foreign store gets every call and only the env token — the toml's password is the other
# store's — and the dev theme (absent from this listing) is not vetted there: refresh is code only
rc=0; L="$TMP/cpt63a"; : > "$L"
run_cpt "$L" SHOPIFY_CLI_THEME_TOKEN=shptka_uk FAKE_LIST="$UK_LIST" -- refresh --store acme-uk --theme 777 --no-build || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^theme_id=777$' "$O" && grep -q '^store=acme-uk$' "$O" \
   && [ "$(grep -c '^argv=' "$L")" -ge 2 ] && ! grep '^argv=' "$L" | grep -qv -- '--store acme-uk ' \
   && ! grep '^token=' "$L" | grep -qv '^token=shptka_uk$' && ! grep -q 'dev_theme_not_found' "$O"; then ok
else bad P63a-store-handle-refresh "rc=$rc out=$(head -c 240 "$O" | tr '\n' ' ') log=$(tr '\n' ';' < "$L")"; fi
# P63b: the domain / https:// URL forms parse too, and one naming the TOML's store in another
# spelling is that store — its token, its dev theme, no note
rc=0; L="$TMP/cpt63b"; : > "$L"
run_cpt "$L" SHOPIFY_CLI_THEME_TOKEN=shptka_uk FAKE_LIST="$UK_LIST" -- refresh --theme 777 --no-build --store https://acme-uk.myshopify.com/ || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^store=acme-uk.myshopify.com$' "$O" \
   && grep -q -- '^argv=theme push --store acme-uk.myshopify.com --theme 777 ' "$L"; then ok
else bad P63b-store-domain-refresh "rc=$rc out=$(head -c 240 "$O" | tr '\n' ' ') log=$(tr '\n' ';' < "$L")"; fi
rc=0; L="$TMP/cpt63b2"; : > "$L"
run_cpt "$L" SHOPIFY_CLI_THEME_TOKEN=shptka_uk -- info --store acme-dev.myshopify.com || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^dev_theme_id=111$' "$O" && ! grep -q '^note=dev_theme_other_store' "$O" \
   && grep -q '^token=shptka_fixture1234$' "$L"; then ok
else bad P63b2-toml-store-other-spelling "rc=$rc out=$(head -c 240 "$O" | tr '\n' ' ') log=$(tr '\n' ';' < "$L")"; fi
# P63c: $SHOPIFY_STORE is the default, --store wins over it; `info` on a foreign store says where
# the dev theme lives
rc=0; L="$TMP/cpt63c"; : > "$L"
run_cpt "$L" SHOPIFY_STORE=acme-uk SHOPIFY_CLI_THEME_TOKEN=shptka_uk FAKE_LIST="$UK_LIST" -- info || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^store=acme-uk$' "$O" && grep -q '^note=dev_theme_other_store toml_store=acme-dev ' "$O"; then ok
else bad P63c-shopify-store-env "rc=$rc out=$(head -c 240 "$O" | tr '\n' ' ')"; fi
rc=0; L="$TMP/cpt63c2"; : > "$L"
run_cpt "$L" SHOPIFY_STORE=acme-other SHOPIFY_CLI_THEME_TOKEN=shptka_uk FAKE_LIST="$UK_LIST" -- info --store acme-uk || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^store=acme-uk$' "$O"; then ok
else bad P63c2-flag-beats-env "rc=$rc out=$(head -c 240 "$O" | tr '\n' ' ')"; fi
# P63d: no env token for a foreign store is refused before any CLI call — the toml's password would
# only reach the CLI as an opaque 401
rc=0; L="$TMP/cpt63d"; : > "$L"
run_cpt "$L" NO=1 -- refresh --store acme-uk --theme 777 --no-build || rc=$?
if [ "$rc" -eq 1 ] && grep -q '^error=no access token for store=acme-uk (--store) — a Theme Access token is minted PER STORE' "$O" \
   && grep -q 'export SHOPIFY_CLI_THEME_TOKEN with acme-uk' "$O" && [ ! -s "$L" ]; then ok
else bad P63d-foreign-store-needs-env-token "rc=$rc out=$(head -c 240 "$O" | tr '\n' ' ') log=$(tr '\n' ';' < "$L")"; fi
# P63e: a token the store rejects says it is minted PER STORE and where it came from — on the
# listing refusal and on the push failure alike; a toml token is told to fix the toml
H63E='^hint=a Theme Access token is minted PER STORE — this one came from \$SHOPIFY_CLI_THEME_TOKEN and the request went to acme-uk.myshopify.com, .*export SHOPIFY_CLI_THEME_TOKEN with acme-uk.myshopify.com'"'"'s own'
rc=0; L="$TMP/cpt63e"; : > "$L"
run_cpt "$L" SHOPIFY_CLI_THEME_TOKEN=shptka_wrong FAKE_REJECT_STORE=acme-uk -- refresh --store acme-uk --theme 777 --no-build || rc=$?
if [ "$rc" -eq 1 ] && grep -q '^error=refresh_unverifiable theme=777 store=acme-uk' "$O" && grep -q "$H63E" "$O" \
   && [ "$(cpt_calls 'theme push' "$L")" -eq 0 ]; then ok
else bad P63e-auth-hint-listing "rc=$rc out=$(head -c 400 "$O" | tr '\n' ' ')"; fi
rc=0; L="$TMP/cpt63e2"; : > "$L"
run_cpt "$L" SHOPIFY_CLI_THEME_TOKEN=shptka_wrong FAKE_REJECT_STORE=acme-uk -- refresh --store acme-uk --theme 777 --no-build --allow-unverified || rc=$?
if [ "$rc" -eq 1 ] && grep -q '^error=refresh_push_failed' "$O" && grep -q "$H63E" "$O"; then ok
else bad P63e2-auth-hint-push "rc=$rc out=$(head -c 400 "$O" | tr '\n' ' ')"; fi
rc=0; L="$TMP/cpt63e3"; : > "$L"
run_cpt "$L" FAKE_REJECT_STORE=acme-dev -- refresh --theme 555 --no-build --allow-unverified || rc=$?
if [ "$rc" -eq 1 ] && grep -q '^error=refresh_push_failed' "$O" \
   && grep -q '^hint=a Theme Access token is minted PER STORE — this one came from shopify.theme.toml and the request went to acme-dev.myshopify.com, .*the password= in shopify.theme.toml is not' "$O"; then ok
else bad P63e3-auth-hint-toml-token "rc=$rc out=$(head -c 400 "$O" | tr '\n' ' ')"; fi
# P63f: create on a foreign store is refused before the build — the settings source is on the toml's
# store, and a fresh theme without its settings has no templates (every page 404s)
rc=0; L="$TMP/cpt63f"; : > "$L"; BM="$TMP/cpt63f.build"; rm -f "$BM"
run_cpt "$L" SHOPIFY_CLI_THEME_TOKEN=shptka_uk CPT_BUILD_MARK="$BM" -- create --name "[ABC-1] UK" --reuse --store acme-uk || rc=$?
if [ "$rc" -eq 1 ] && grep -q '^error=overlay_store_mismatch store=acme-uk (--store) toml_store=acme-dev dev_theme=111 ' "$O" \
   && grep -q 'refresh --store acme-uk --theme <id>' "$O" && [ ! -s "$L" ] && [ ! -e "$BM" ]; then ok
else bad P63f-create-foreign-refused "rc=$rc out=$(head -c 240 "$O" | tr '\n' ' ') log=$(tr '\n' ';' < "$L")"; fi
# P63g: a pin on a foreign store is refused — the block it writes names the other store
TOMLH63="$(cksum < "$CPTD/repo/shopify.theme.toml")"
for pc in "pin --theme 777 --store acme-uk" "refresh --theme 777 --no-build --pin-toml --store acme-uk"; do
  rc=0; L="$TMP/cpt63g"; : > "$L"
  run_cpt "$L" SHOPIFY_CLI_THEME_TOKEN=shptka_uk FAKE_LIST="$UK_LIST" -- $pc || rc=$?
  if [ "$rc" -eq 1 ] && grep -q '^error=pin_store_mismatch store=acme-uk (--store) toml_store=acme-dev ' "$O" && [ ! -s "$L" ] \
     && [ "$(cksum < "$CPTD/repo/shopify.theme.toml")" = "$TOMLH63" ]; then ok
  else bad "P63g-pin-foreign-refused[$pc]" "rc=$rc out=$(head -c 240 "$O" | tr '\n' ' ')"; fi
done
# P63f2: a refusal caused by an exported $SHOPIFY_STORE says so — a stale export for another project
# otherwise reads as an unexplained refusal — and names a block selector this subcommand takes
rc=0; L="$TMP/cpt63f2"; : > "$L"
run_cpt "$L" SHOPIFY_STORE=acme-uk SHOPIFY_CLI_THEME_TOKEN=shptka_uk -- create --name "[ABC-1] UK" --no-build || rc=$?
if [ "$rc" -eq 1 ] && grep -q '^error=overlay_store_mismatch store=acme-uk (\$SHOPIFY_STORE — unset it if it was exported for another project) toml_store=acme-dev ' "$O" \
   && grep -q 'whose store is acme-uk: export SHOPIFY_FLAG_ENVIRONMENT=<name>' "$O" && [ ! -s "$L" ]; then ok
else bad P63f2-overlay-refusal-names-source "rc=$rc out=$(head -c 400 "$O" | tr '\n' ' ')"; fi
# P63h: theme_not_found names the other-store way out — refresh re-runs with --store; a pin can only
# land in the block naming that store, so it is pointed there instead of into pin_store_mismatch
H63H_REFRESH='pass --store <handle> (a `\*.myshopify.com` preview URL'"'"'s host or the editor URL'"'"'s `/store/<handle>/` names it)$'
H63H_PIN='a pin can only go into the toml block whose store it is (`--env <that block>`, or `--store <handle>` when a block names that store)$'
for nc in "refresh --theme 333 --no-build" "pin --theme 333"; do
  case "$nc" in refresh*) H="$H63H_REFRESH" ;; *) H="$H63H_PIN" ;; esac
  rc=0; L="$TMP/cpt63h"; : > "$L"
  run_cpt "$L" FAKE_LIST='[{"id":111,"name":"[DEV] Kever","role":"development"}]' -- $nc || rc=$?
  if [ "$rc" -eq 1 ] && grep -q '^error=theme_not_found theme=333 store=acme-dev — .* or the id lives on another store: ' "$O" \
     && grep -q -- "$H" "$O"; then ok
  else bad "P63h-not-found-store-hint[$nc]" "rc=$rc out=$(head -c 400 "$O" | tr '\n' ' ')"; fi
done
# P63i: in a toml whose blocks name different stores, --store picks the block that names it — its
# token and its dev theme — where the bare run is ambiguous_env
F63I="$TMP/cpt63i.toml"
printf '[environments.us]\nstore = "acme-us"\ntheme = "111"\npassword = "shptka_us"\n\n[environments.uk]\nstore = "acme-uk"\ntheme = "444"\npassword = "shptka_ukblock"\n' > "$F63I"
rc=0; L="$TMP/cpt63i"; : > "$L"
run_cpt "$L" TOML_PATH="$F63I" -- info --store acme-uk.myshopify.com || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^env=uk$' "$O" && grep -q '^dev_theme_id=444$' "$O" && ! grep -q '^note=' "$O" \
   && grep -q '^token=shptka_ukblock$' "$L"; then ok
else bad P63i-store-picks-block "rc=$rc out=$(head -c 240 "$O" | tr '\n' ' ') log=$(tr '\n' ';' < "$L")"; fi
rc=0; L="$TMP/cpt63i2"; : > "$L"
run_cpt "$L" TOML_PATH="$F63I" -- info || rc=$?
if [ "$rc" -eq 1 ] && grep -q '^error=ambiguous_env' "$O"; then ok
else bad P63i2-bare-still-ambiguous "rc=$rc out=$(head -c 240 "$O" | tr '\n' ' ')"; fi
# P63k: a toml with no `store =` line has no store to be foreign to — --store fills it, and the
# toml's own password still authenticates
F63K="$TMP/cpt63k.toml"
printf 'theme = "111"\npassword = "shptka_nostore"\n' > "$F63K"
rc=0; L="$TMP/cpt63k"; : > "$L"
run_cpt "$L" TOML_PATH="$F63K" -- info --store acme-uk || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^store=acme-uk$' "$O" && ! grep -q '^note=dev_theme_other_store' "$O" \
   && grep -q '^token=shptka_nostore$' "$L"; then ok
else bad P63k-storeless-toml-not-foreign "rc=$rc out=$(head -c 240 "$O" | tr '\n' ' ') log=$(tr '\n' ';' < "$L")"; fi
# P63l: the auth-rejection matcher is theme-json.sh's, byte for byte — a fix to one must reach both
AUTH_RE="$(grep -o "grep -qiE '[^']*401[^']*'" "$CPT" | head -1)"
if [ -n "$AUTH_RE" ] && grep -qF -- "$AUTH_RE" "$TJ"; then ok
else bad P63l-auth-matcher-drift "cpt=[$AUTH_RE]"; fi
# P63j: --store as the last arg is a usage error, not a silent run against the toml store
rc=0; L="$TMP/cpt63j"; : > "$L"
run_cpt "$L" NO=1 -- refresh --theme 777 --no-build --store || rc=$?
if [ "$rc" -eq 1 ] && grep -q '^error=missing value for --store$' "$O" && [ ! -s "$L" ]; then ok
else bad P63j-store-missing-value "rc=$rc out=$(head -c 240 "$O" | tr '\n' ' ') log=$(tr '\n' ';' < "$L")"; fi

# ------------------------------------------- fix-breaking-changes banner handling --
FB="$TMP/fb"; mkdir -p "$FB/templates/customers" "$FB/config" "$FB/scripts"
printf '/* banner\n * auto-generated by Shopify\n*/\n{"current":{"x":1}}\n' > "$FB/config/settings_data.json"
printf '{"sections":{}}\n' > "$FB/templates/index.json"
printf '{"sections":{}}\n' > "$FB/templates/customers/account.json"
cp "$FBC" "$FB/scripts/fix-breaking-changes.js"
rc=0; (cd "$FB" && node scripts/fix-breaking-changes.js) >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && ! grep -q 'Error processing' "$O" "$E"; then ok; else bad F1-banner-config "rc=$rc :: $(grep 'Error processing' "$O" "$E" | head -2)"; fi
if head -1 "$FB/config/settings_data.json" | grep -q '/\* banner'; then ok; else bad F2-banner-preserved "banner lost: $(head -1 "$FB/config/settings_data.json")"; fi

# ---- session-theme.sh: the shared pin/un-pin library ----
# The library is exercised in-process by every P* case (create-preview-theme.sh sources it) and by
# the WT cases (worktree-theme.sh runs it). What is left is its own command surface: the exit codes
# worktree-theme.sh reads, the silence its stdout owes a file holding the Theme Access token, and
# the markers an fnd-era pin left behind.
STD="$TMP/st"; mkdir -p "$STD"

# S1: the CLI reverts a rewrite, answers 0 and says nothing at all — a caller that does not
# redirect this stdout, so a printed line would land in the key=value stream a skill relays
printf '[environments.development]\nstore = "acme-dev"\n# theme = "111"  # fe:superseded\ntheme = "777"\npassword = "shptka_fixture1234"\n' > "$STD/s1.toml"
rc=0; "$BASH_BIN" "$STL" unpin "$STD/s1.toml" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ ! -s "$O" ] \
   && grep -q '^theme = "111"$' "$STD/s1.toml" && grep -q '^# theme = "777"$' "$STD/s1.toml" \
   && ! grep -q 'fe:superseded' "$STD/s1.toml" \
   && grep -q '^password = "shptka_fixture1234"$' "$STD/s1.toml"; then ok
else bad S1-cli-unpin-reverts "rc=$rc out=$(head -c 120 "$O" | grep -v password | tr '\n' ' ') err=$(head -c 120 "$E" | tr '\n' ' ')"; fi

# S2: never pinned → 1, and the file is byte-identical (the copy a worktree keeps as it came)
printf '[environments.development]\nstore = "acme-dev"\ntheme = "111"\n' > "$STD/s2.toml"
st_before="$(fhash "$STD/s2.toml")"
rc=0; "$BASH_BIN" "$STL" unpin "$STD/s2.toml" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 1 ] && [ ! -s "$O" ] && [ "$(fhash "$STD/s2.toml")" = "$st_before" ]; then ok
else bad S2-cli-unpin-nothing-to-revert "rc=$rc out=$(head -c 120 "$O" | grep -v password | tr '\n' ' ')"; fi

# S3: an absent config is "nothing to revert", not a crash — a worktree with no toml at all is a
# state worktree-theme.sh reports and carries on from
rc=0; "$BASH_BIN" "$STL" unpin "$STD/nope.toml" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 1 ] && [ ! -s "$O" ]; then ok
else bad S3-cli-unpin-absent "rc=$rc out=$(head -c 120 "$O" | grep -v password | tr '\n' ' ')"; fi

# S4: nothing else is dispatchable — a bare run, an unknown subcommand and a pathless `unpin` all
# stop at the usage line, and the `pin` attempt writes nothing
st_s1_before="$(fhash "$STD/s1.toml")"
st_usage_ok=1
for st_case in bare pin pathless; do
  case "$st_case" in bare) set -- ;; pin) set -- pin "$STD/s1.toml" ;; pathless) set -- unpin ;; esac
  rc=0; "$BASH_BIN" "$STL" "$@" >"$O" 2>"$E" || rc=$?
  [ "$rc" -eq 2 ] || st_usage_ok=0
  grep -q '^error=usage: session-theme.sh unpin <toml> (--help prints usage)$' "$O" || st_usage_ok=0
done
if [ "$st_usage_ok" -eq 1 ] && [ "$(fhash "$STD/s1.toml")" = "$st_s1_before" ]; then ok
else bad S4-cli-usage "usage contract broken :: rc=$rc out=$(head -c 120 "$O" | grep -v password | tr '\n' ' ')"; fi

# S4b (drift guard): `--help` / `-h` answer with the header's own `# Usage:` block, rc 0
STH="$TMP/st-usage-header"
awk '/^# Usage:/ { f = 1 } f { if ($0 == "#" || $0 !~ /^#( |$)/) exit; sub(/^# ?/, ""); print }' \
  "$STL" > "$STH"
for ha in --help -h; do
  rc=0; "$BASH_BIN" "$STL" "$ha" >"$O" 2>"$E" || rc=$?
  if [ "$rc" -eq 0 ] && [ ! -s "$E" ] && [ "$(head -1 "$O")" = "Usage:" ] \
     && [ "$(wc -l < "$STH" | tr -d ' ')" -ge 4 ] && sed '$d' "$O" | diff -q - "$STH" >/dev/null \
     && [ "$(tail -1 "$O")" = "Full contract: the header of $STL" ]; then ok
  else bad "S4b-help[$ha]" "rc=$rc diff=$(sed '$d' "$O" | diff - "$STH" | head -c 300 | tr '\n' ';') err=$(head -c 120 "$E" | tr '\n' ' ')"; fi
done

# S4c: `--help` among a real unpin's args is a usage question — the pinned file is not rewritten
st_s1_before="$(fhash "$STD/s1.toml")"
rc=0; "$BASH_BIN" "$STL" unpin "$STD/s1.toml" --help >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ "$(head -1 "$O")" = "Usage:" ] && [ "$(fhash "$STD/s1.toml")" = "$st_s1_before" ]; then ok
else bad S4c-help-mid-args "rc=$rc out=$(head -c 120 "$O" | grep -v password | tr '\n' ' ')"; fi

# S4d: a SOURCED copy never answers — create-preview-theme.sh sources the file with its own args in
# "$@", and a usage block (or an exit) there would land in its key=value stream
rc=0; ( set -- --help; . "$STL"; printf 'still-here\n' ) >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ "$(cat "$O")" = "still-here" ] && [ ! -s "$E" ]; then ok
else bad S4d-sourced-help-silent "rc=$rc out=$(head -c 160 "$O" | tr '\n' ';') err=$(head -c 120 "$E" | tr '\n' ' ')"; fi

# S7: a pin that is there but cannot be rewritten (read-only copy) is 3, not the 1 of "never
# pinned" — the caller must be able to tell a config it still has to fix from one that was clean
printf '[environments.development]\nstore = "acme-dev"\n# theme = "111"  # fe:superseded\ntheme = "777"\npassword = "shptka_fixture7"\n' > "$STD/s7.toml"
chmod 444 "$STD/s7.toml"; st_before="$(fhash "$STD/s7.toml")"
rc=0; "$BASH_BIN" "$STL" unpin "$STD/s7.toml" >"$O" 2>"$E" || rc=$?
chmod 644 "$STD/s7.toml"
if [ "$rc" -eq 3 ] && [ ! -s "$O" ] && [ "$(fhash "$STD/s7.toml")" = "$st_before" ]; then ok
else bad S7-cli-unpin-rewrite-failed "rc=$rc out=$(head -c 120 "$O" | grep -v password | tr '\n' ' ') err=$(head -c 120 "$E" | grep -v password | tr '\n' ' ')"; fi

# S8: a pin the fnd plugin wrote (`fnd` in place of `fe` in the marker) is reverted the same way —
# a checkout that moved to fe keeps its shared dev theme recoverable
printf '[environments.development]\nstore = "acme-dev"\n# theme = "111"  # fnd:superseded\ntheme = "777"\npassword = "shptka_fixture8"\n' > "$STD/s8.toml"
rc=0; "$BASH_BIN" "$STL" unpin "$STD/s8.toml" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ ! -s "$O" ] && grep -q '^theme = "111"$' "$STD/s8.toml" \
   && grep -q '^# theme = "777"$' "$STD/s8.toml" && ! grep -q 'superseded' "$STD/s8.toml"; then ok
else bad S8-legacy-superseded-unpinned "rc=$rc file=$(grep -v password "$STD/s8.toml" | tr '\n' ';')"; fi
# S8b: …and an fnd append tag is session-owned the same way: the un-pin deletes the line
printf '[environments.development]\nstore = "acme-dev"\ntheme = "777" # fnd:session-theme\n' > "$STD/s8b.toml"
rc=0; "$BASH_BIN" "$STL" unpin "$STD/s8b.toml" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && ! grep -q 'theme' "$STD/s8b.toml" && grep -q '^store = "acme-dev"$' "$STD/s8b.toml"; then ok
else bad S8b-legacy-tag-unpinned "rc=$rc file=$(tr '\n' ';' < "$STD/s8b.toml")"; fi
# S8c: the shared-dev-theme guard reads the fnd marker too — the superseded id is the shared one,
# the pinned session id is not
printf '[environments.development]\nstore = "acme-dev"\n# theme = "111"  # fnd:superseded\ntheme = "777"\n' > "$STD/s8c.toml"
o="$( . "$STL"; shared_dev_theme_ids "$STD/s8c.toml" "" 0 0 | tr '\n' ' ')"
if [ "$o" = "111 " ]; then ok; else bad S8c-legacy-shared-ids "ids='$o' want='111 '"; fi
# S8d: a re-pin over an fnd pin swaps the value and stacks no second marker — the first pin's
# superseded line is still the one worth restoring
rc=0; o="$( TOML="$STD/s8c.toml"; PIN_ENV=""; . "$STL"; pin_toml 888 && printf '%s' "$PIN_ACTION")" || rc=$?
if [ "$rc" -eq 0 ] && [ "$o" = rewritten ] && grep -q '^theme = "888"$' "$STD/s8c.toml" \
   && [ "$(grep -c 'superseded' "$STD/s8c.toml")" -eq 1 ] && grep -q '^# theme = "111"  # fnd:superseded$' "$STD/s8c.toml"; then ok
else bad S8d-repin-over-legacy "rc=$rc action='$o' file=$(tr '\n' ';' < "$STD/s8c.toml")"; fi
# S8e: a fresh pin writes the fe spelling only
printf '[environments.development]\nstore = "acme-dev"\ntheme = "111"\n' > "$STD/s8e.toml"
rc=0; ( TOML="$STD/s8e.toml"; PIN_ENV=""; . "$STL"; pin_toml 999 ) >/dev/null 2>&1 || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^# theme = "111"  # fe:superseded$' "$STD/s8e.toml" && ! grep -q 'fnd' "$STD/s8e.toml"; then ok
else bad S8e-pin-writes-fe "rc=$rc file=$(tr '\n' ';' < "$STD/s8e.toml")"; fi

# ═══ EV — domaine env files: the bash reader _shopify-common.sh owns ═══════════════════════════
# fe ships no Node loader for these files: domaine_env() is the one reader the Shopify scripts use
# (extracted from the shipped file, so this tests the real code).
EVR="$TMP/env"; mkdir -p "$EVR/cfg/domaine" "$EVR/repo/sub" "$EVR/repo/.claude"
git init -q "$EVR/repo"
eval "$(sed -n '/^domaine_env()/,/^}/p' "$COMMON")"

# EV1: project-first walk-up from a subdirectory, first-'=' split, a value with spaces intact; a
# directory with no project file above it reads nothing
printf 'FE_CPT_THROTTLE_WAITS=5 9\n' > "$EVR/repo/.claude/domaine.env"
o1="$(cd "$EVR/repo/sub" && XDG_CONFIG_HOME="$EVR/cfg" domaine_env FE_CPT_THROTTLE_WAITS)"
o2="$(cd "$EVR/cfg" && XDG_CONFIG_HOME="$EVR/cfg" domaine_env FE_CPT_THROTTLE_WAITS)"
if [ "$o1" = "5 9" ] && [ "$o2" = "" ]; then ok; else bad EV1-bash-reader "o1='$o1' o2='$o2'"; fi

# EV2: single home — a private domaine_env() in any script would let the allowlists drift
if [ "$(cat "$CPT" "$GQL" "$TJ" "$WTT" | grep -c '^domaine_env() {')" -eq 0 ] && [ -n "$(type -t domaine_env)" ]; then ok
else bad EV2-domaine-env-single-home "domaine_env() is defined outside _shopify-common.sh (or the lib's copy did not load)"; fi

# EV3: the project file is committable by a client repo, so it carries the tuning keys only — a
# verify gate there is not even looked for (the global value wins), and an unlisted FE_* key is
# global-only too (default-deny)
printf 'FE_CPT_OVERLAY_VERIFY=0\nFE_THEME_JSON_VERIFY=0\nFE_FUTURE_SWITCH=1\nFE_CPT_OVERLAY_VERIFY_WAIT=9\n' \
  > "$EVR/repo/.claude/domaine.env"
printf 'FE_CPT_OVERLAY_VERIFY=1\nFE_THEME_JSON_VERIFY=1\n' > "$EVR/cfg/domaine/env"
o3=""
for k in FE_CPT_OVERLAY_VERIFY FE_THEME_JSON_VERIFY FE_FUTURE_SWITCH FE_CPT_OVERLAY_VERIFY_WAIT; do
  o3="$o3$k=[$(cd "$EVR/repo" && XDG_CONFIG_HOME="$EVR/cfg" domaine_env "$k")] "
done
if [ "$o3" = "FE_CPT_OVERLAY_VERIFY=[1] FE_THEME_JSON_VERIFY=[1] FE_FUTURE_SWITCH=[] FE_CPT_OVERLAY_VERIFY_WAIT=[9] " ]; then ok
else bad EV3-project-class-split "got='$o3'"; fi

# EV4: every tuning key the scripts and the profile probe read does reach the project layer
EVK="FE_PROFILE FE_GQL_PROBE_CACHE FE_CPT_THROTTLE_WAITS FE_CPT_OVERLAY_VERIFY_WAIT FE_THEME_JSON_VERIFY_WAIT SHOPIFY_ADMIN_GQL_QUIET"
: > "$EVR/repo/.claude/domaine.env"; : > "$EVR/cfg/domaine/env"
for k in $EVK; do printf '%s=p\n' "$k" >> "$EVR/repo/.claude/domaine.env"; done
o4=""
for k in $EVK; do o4="$o4$(cd "$EVR/repo/sub" && XDG_CONFIG_HOME="$EVR/cfg" domaine_env "$k")"; done
if [ "$o4" = "pppppp" ]; then ok; else bad EV4-project-ok-keys "got='$o4' want six p"; fi

# EV5: the old FND_* spelling answers nothing — fe reads its own prefix only, in both layers
printf 'FND_GQL_PROBE_CACHE=0\nFND_CPT_THROTTLE_WAITS=1 1\n' > "$EVR/repo/.claude/domaine.env"
printf 'FND_GQL_PROBE_CACHE=0\n' > "$EVR/cfg/domaine/env"
o5="$(cd "$EVR/repo" && XDG_CONFIG_HOME="$EVR/cfg" domaine_env FE_GQL_PROBE_CACHE)$(cd "$EVR/repo" && XDG_CONFIG_HOME="$EVR/cfg" domaine_env FE_CPT_THROTTLE_WAITS)"
if [ -z "$o5" ]; then ok; else bad EV5-legacy-prefix-ignored "got='$o5'"; fi

# EV6: the dialect — leading indent, spaces around '=', trailing spaces, a CRLF line, a duplicate
# (first wins), a comment, and an EMPTY project value that shadows the global one (the first layer
# that carries the key wins; callers read empty as "no value")
printf '# comment\n  FE_GQL_PROBE_CACHE = 75 \nFE_CPT_THROTTLE_WAITS=5 9   \nFE_THEME_JSON_VERIFY_WAIT = 1\r\nFE_GQL_PROBE_CACHE=9\nFE_CPT_OVERLAY_VERIFY_WAIT=\n' \
  > "$EVR/repo/.claude/domaine.env"
printf 'FE_CPT_OVERLAY_VERIFY_WAIT=7\nFE_PROFILE = theme\n' > "$EVR/cfg/domaine/env"
o6=""
for k in FE_GQL_PROBE_CACHE FE_CPT_THROTTLE_WAITS FE_THEME_JSON_VERIFY_WAIT FE_CPT_OVERLAY_VERIFY_WAIT FE_PROFILE; do
  o6="$o6$k=[$(cd "$EVR/repo/sub" && XDG_CONFIG_HOME="$EVR/cfg" domaine_env "$k")] "
done
EVWANT='FE_GQL_PROBE_CACHE=[75] FE_CPT_THROTTLE_WAITS=[5 9] FE_THEME_JSON_VERIFY_WAIT=[1] FE_CPT_OVERLAY_VERIFY_WAIT=[] FE_PROFILE=[theme] '
if [ "$o6" = "$EVWANT" ]; then ok; else bad EV6-reader-dialect "got='$o6' want='$EVWANT'"; fi

# ═══ PP — project-profile.sh: the session profile probe ═════════════════════════════════════
# The one place the foundation/theme/none answer is derived; fe's hooks module gates the
# Foundation-only conventions on what it prints, and worktree-theme.sh picks the dev-server line by
# it. `PP`, not `P` — the P labels above belong to create-preview-theme.sh.
PPS="$ROOT/plugins/fe/scripts/project-profile.sh"
PPR="$TMP/pp"; mkdir -p "$PPR"
pp_out=""; pp_rc=0
pp_run() { # <dir-or-args…> — stdout in $pp_out, exit code in $pp_rc, stderr in $E
  pp_rc=0
  pp_out="$("$BASH_BIN" "$PPS" "$@" 2>"$E")" || pp_rc=$?
}
pp_eq() { # <label> <want-profile> <dir>
  pp_run "$3"
  if [ "$pp_rc" -eq 0 ] && [ "$pp_out" = "$2" ]; then ok
  else bad "$1" "rc=$pp_rc profile='$pp_out' want='$2' err=$(head -c 120 "$E" | tr '\n' ' ')"; fi
}

# PP1: each Foundation marker on its own — one is enough, and the four are the naming Foundation
# core actually ships under (three globs and a directory)
mkdir -p "$PPR/m-snippet/snippets"; : > "$PPR/m-snippet/snippets/@card.liquid"
mkdir -p "$PPR/m-section/sections"; : > "$PPR/m-section/sections/core-hero.liquid"
mkdir -p "$PPR/m-block/blocks";     : > "$PPR/m-block/blocks/core-text.liquid"
mkdir -p "$PPR/m-entry/src/entry/core"
for m in snippet section block entry; do
  pp_eq "PP1-marker-$m" foundation "$PPR/m-$m"
done

# PP1b: a near-miss of each glob is NOT a marker — an ordinary snippet, a non-core section, a
# section named core-* under the wrong extension
mkdir -p "$PPR/near/snippets" "$PPR/near/sections"
: > "$PPR/near/snippets/card.liquid"; : > "$PPR/near/sections/hero.liquid"
: > "$PPR/near/sections/core-hero.json"
pp_eq PP1b-near-miss none "$PPR/near"

# PP2: precedence — a Foundation checkout has a layout/theme.liquid too, so the markers have to
# win over it; a plain theme is `theme`; a directory that is neither is `none`
mkdir -p "$PPR/both/snippets" "$PPR/both/layout"
: > "$PPR/both/snippets/@card.liquid"; : > "$PPR/both/layout/theme.liquid"
pp_eq PP2-foundation-wins foundation "$PPR/both"
mkdir -p "$PPR/theme/layout"; : > "$PPR/theme/layout/theme.liquid"
pp_eq PP2-theme theme "$PPR/theme"
mkdir -p "$PPR/empty"
pp_eq PP2-none none "$PPR/empty"
# …and layout/theme.liquid as a DIRECTORY is not a theme marker either (the test is -f)
mkdir -p "$PPR/dirlayout/layout/theme.liquid"
pp_eq PP2b-layout-dir none "$PPR/dirlayout"

# PP3: no argument at all → the working directory, which is what every wiring relies on (the
# hook command runs in the session's cwd and passes no path)
pp_rc=0
pp_out="$(cd "$PPR/m-snippet" && "$BASH_BIN" "$PPS" 2>"$E")" || pp_rc=$?
if [ "$pp_rc" -eq 0 ] && [ "$pp_out" = foundation ]; then ok
else bad PP3-default-cwd "rc=$pp_rc profile='$pp_out'"; fi

# PP4: FE_PROFILE from the process env forces each valid value, detection notwithstanding
for v in foundation theme none; do
  pp_rc=0
  pp_out="$(FE_PROFILE="$v" "$BASH_BIN" "$PPS" "$PPR/theme" 2>"$E")" || pp_rc=$?
  if [ "$pp_rc" -eq 0 ] && [ "$pp_out" = "$v" ]; then ok
  else bad "PP4-override-$v" "rc=$pp_rc profile='$pp_out' want='$v'"; fi
done

# PP4b: the process-env value is trimmed like a file value — the hooks module and the doctor trim
# it too, so `FE_PROFILE='foundation '` (a settings.json value with a stray space) forces the same
# word in all three instead of warning here and detecting `theme`
pp_rc=0
pp_out="$(FE_PROFILE=' foundation ' "$BASH_BIN" "$PPS" "$PPR/theme" 2>"$E")" || pp_rc=$?
if [ "$pp_rc" -eq 0 ] && [ "$pp_out" = foundation ] && [ ! -s "$E" ]; then ok
else bad PP4b-env-trimmed "rc=$pp_rc profile='$pp_out' err=$(head -c 120 "$E" | tr '\n' ' ')"; fi

# PP5: the same override out of a project `.claude/domaine.env`, found by walking UP from a
# subdirectory — the domaine env project layer, in its dialect (comment, spaces around `=`)
mkdir -p "$PPR/proj/.claude" "$PPR/proj/sub/deep" "$PPR/proj/layout"
: > "$PPR/proj/layout/theme.liquid"
printf '# per-project\nFE_PROFILE = foundation \n' > "$PPR/proj/.claude/domaine.env"
pp_eq PP5-project-file foundation "$PPR/proj/sub/deep"
# the process env still wins over the file
pp_rc=0
pp_out="$(FE_PROFILE=none "$BASH_BIN" "$PPS" "$PPR/proj/sub/deep" 2>"$E")" || pp_rc=$?
if [ "$pp_rc" -eq 0 ] && [ "$pp_out" = none ]; then ok
else bad PP5b-env-beats-file "rc=$pp_rc profile='$pp_out'"; fi
# …and the GLOBAL file is the last layer, below the project one
PPG="$PPR/xdg"; mkdir -p "$PPG/domaine"
printf 'FE_PROFILE=none\n' > "$PPG/domaine/env"
pp_rc=0
pp_out="$(XDG_CONFIG_HOME="$PPG" "$BASH_BIN" "$PPS" "$PPR/proj/sub/deep" 2>"$E")" || pp_rc=$?
if [ "$pp_rc" -eq 0 ] && [ "$pp_out" = foundation ]; then ok
else bad PP5c-project-beats-global "rc=$pp_rc profile='$pp_out'"; fi
pp_rc=0
pp_out="$(XDG_CONFIG_HOME="$PPG" "$BASH_BIN" "$PPS" "$PPR/m-snippet" 2>"$E")" || pp_rc=$?
if [ "$pp_rc" -eq 0 ] && [ "$pp_out" = none ]; then ok
else bad PP5d-global-file "rc=$pp_rc profile='$pp_out'"; fi

# PP6: an override that is not one of the three words is not a verdict — it warns and detection
# decides, because a typo in a config file may not silence a convention set
pp_rc=0
pp_out="$(FE_PROFILE=Foundation "$BASH_BIN" "$PPS" "$PPR/m-snippet" 2>"$E")" || pp_rc=$?
if [ "$pp_rc" -eq 0 ] && [ "$pp_out" = foundation ] && grep -q '^warn=bad_profile value=Foundation' "$E"; then ok
else bad PP6-bad-value "rc=$pp_rc profile='$pp_out' err=$(head -c 120 "$E" | tr '\n' ' ')"; fi

# PP7: the two argument errors — both exit 2, so a caller can tell "this directory is not a
# Foundation theme" from "you asked about a directory that is not there"
pp_run "$PPR/does-not-exist"
if [ "$pp_rc" -eq 2 ] && [ -z "$pp_out" ] && grep -q "^error=no_such_dir dir=$PPR/does-not-exist$" "$E"; then ok
else bad PP7-missing-dir "rc=$pp_rc out='$pp_out' err=$(head -c 120 "$E" | tr '\n' ' ')"; fi
pp_run "$PPR/empty" "$PPR/theme"
if [ "$pp_rc" -eq 2 ] && [ -z "$pp_out" ] && grep -q '^usage: project-profile.sh' "$E"; then ok
else bad PP7b-two-args "rc=$pp_rc out='$pp_out' err=$(head -c 120 "$E" | tr '\n' ' ')"; fi
# a FILE where a directory was named is the same refusal
: > "$PPR/afile"
pp_run "$PPR/afile"
if [ "$pp_rc" -eq 2 ] && grep -q '^error=no_such_dir' "$E"; then ok
else bad PP7c-file-arg "rc=$pp_rc err=$(head -c 120 "$E" | tr '\n' ' ')"; fi

# PP8: a stripped environment — no HOME, no PATH, no XDG_CONFIG_HOME. The probe runs on every
# session and subagent start, under `set -u`, and reads env files whose paths are built from
# variables that are not always there.
pp_rc=0
pp_out="$(env -i "$BASH_BIN" "$PPS" "$PPR/m-snippet" 2>"$E")" || pp_rc=$?
if [ "$pp_rc" -eq 0 ] && [ "$pp_out" = foundation ] && [ ! -s "$E" ]; then ok
else bad PP8-stripped-env "rc=$pp_rc profile='$pp_out' err=$(head -c 200 "$E" | tr '\n' ' ')"; fi
pp_rc=0
pp_out="$(env -i FE_PROFILE=theme "$BASH_BIN" "$PPS" "$PPR/empty" 2>"$E")" || pp_rc=$?
if [ "$pp_rc" -eq 0 ] && [ "$pp_out" = theme ]; then ok
else bad PP8b-stripped-override "rc=$pp_rc profile='$pp_out'"; fi

# PP9: a directory whose name carries a glob character still answers about ITSELF — the marker
# patterns are globs, and only their own segment may expand
mkdir -p "$PPR/od[d]/snippets"; : > "$PPR/od[d]/snippets/@card.liquid"
pp_eq PP9-glob-in-path foundation "$PPR/od[d]"

# PP10: the project layer is the NEAREST `.claude/domaine.env`, carrying the key or not — the
# dialect's project file, so the probe names the same file any other reader of it does. A walk that
# kept climbing to the first file that HAPPENS to set FE_PROFILE would let an ancestor govern
# every checkout below it.
mkdir -p "$PPR/stack/.claude" "$PPR/stack/repo/.claude" "$PPR/stack/repo/sub/snippets"
: > "$PPR/stack/repo/sub/snippets/@card.liquid"       # detection would say `foundation` here
printf 'FE_PROFILE=none\n' > "$PPR/stack/.claude/domaine.env"
printf 'FE_LEAN=0\n'       > "$PPR/stack/repo/.claude/domaine.env"
pp_eq PP10-nearest-file-only foundation "$PPR/stack/repo/sub"
# …and when the nearest file is silent the GLOBAL layer decides — the
# ancestor's file is not a layer at all here
PPG2="$PPR/xdg2"; mkdir -p "$PPG2/domaine"
printf 'FE_PROFILE=theme\n' > "$PPG2/domaine/env"
pp_out="$(XDG_CONFIG_HOME="$PPG2" "$BASH_BIN" "$PPS" "$PPR/stack/repo/sub" 2>"$E")"
if [ "$pp_out" = theme ]; then ok
else bad PP10b-global-after-silent-project "profile='$pp_out' want='theme'"; fi
# a nearest file that DOES carry the key wins over both the ancestor and the global layer
printf 'FE_PROFILE=none\n' > "$PPR/stack/repo/.claude/domaine.env"
pp_out="$(XDG_CONFIG_HOME="$PPG2" "$BASH_BIN" "$PPS" "$PPR/stack/repo/sub" 2>"$E")"
if [ "$pp_out" = none ]; then ok
else bad PP10d-nearest-key-wins "profile='$pp_out' want='none'"; fi

# PP11: a checkout reached through a symlink resolves PHYSICALLY — a process's cwd is reported with
# the links already gone, so a lexical walk here would answer differently by call shape. Both have
# to land on the same file: the mod runs the probe with the project as an argument, a by-hand run
# from the cwd.
mkdir -p "$PPR/phys/repo" "$PPR/phys/.claude" "$PPR/logi/.claude"
printf 'FE_PROFILE=theme\n'      > "$PPR/phys/.claude/domaine.env"
printf 'FE_PROFILE=foundation\n' > "$PPR/logi/.claude/domaine.env"
ln -s "$PPR/phys/repo" "$PPR/logi/repo"
pp_eq PP11-physical-arg theme "$PPR/logi/repo"
pp_rc=0
pp_out="$(cd "$PPR/logi/repo" && "$BASH_BIN" "$PPS" 2>"$E")" || pp_rc=$?
if [ "$pp_rc" -eq 0 ] && [ "$pp_out" = theme ]; then ok
else bad PP11b-physical-cwd "rc=$pp_rc profile='$pp_out' want='theme'"; fi
# PP12: detection climbs the way the env layer does — a hook started in a SUBDIRECTORY answers
# about the checkout — and stops at the repo boundary, because a marker outside this repo
# describes somebody else's project, not this one.
pp_eq PP12-walk-up foundation "$PPR/m-section/sections"
mkdir -p "$PPR/gitrepo/.git" "$PPR/gitrepo/sub" "$PPR/gitrepo/sibling/layout"
: > "$PPR/gitrepo/sibling/layout/theme.liquid"
pp_eq PP12b-sibling-is-not-an-ancestor none "$PPR/gitrepo/sub"
mkdir -p "$PPR/outer/snippets" "$PPR/outer/inner/.git"
: > "$PPR/outer/snippets/@card.liquid"
pp_eq PP12c-marker-above-the-boundary none "$PPR/outer/inner"
# a `.git` FILE (worktree, submodule) is the same boundary as the directory
mkdir -p "$PPR/outer/wt"; printf 'gitdir: /elsewhere\n' > "$PPR/outer/wt/.git"
pp_eq PP12d-git-file-boundary none "$PPR/outer/wt"

# PP13: an EMPTY first argument is a caller whose variable did not resolve, not "use the working
# directory" — answering about wherever the hook happened to start is the silent wrong answer
pp_run ""
if [ "$pp_rc" -eq 2 ] && [ -z "$pp_out" ] && grep -q '^error=no_such_dir dir=$' "$E"; then ok
else bad PP13-empty-arg "rc=$pp_rc out='$pp_out' err=$(head -c 120 "$E" | tr '\n' ' ')"; fi

# PP14: a BOM on the first line is invisible to the developer and to JS (String.trim() strips
# U+FEFF) — one editor's save may not silently disarm an override on the bash side only
mkdir -p "$PPR/bom/.claude" "$PPR/bom/snippets"; : > "$PPR/bom/snippets/@card.liquid"
printf '\357\273\277FE_PROFILE=theme\n' > "$PPR/bom/.claude/domaine.env"
pp_eq PP14-bom-first-line theme "$PPR/bom"

# PP15: an exported-but-EMPTY FE_PROFILE is a value the process env CARRIES — process env wins
# whenever it carries the key, so the empty string shadows both files and detection has the last word
mkdir -p "$PPR/emptyenv/.claude" "$PPR/emptyenv/snippets"; : > "$PPR/emptyenv/snippets/@card.liquid"
printf 'FE_PROFILE=theme\n' > "$PPR/emptyenv/.claude/domaine.env"
pp_rc=0
pp_out="$(FE_PROFILE= "$BASH_BIN" "$PPS" "$PPR/emptyenv" 2>"$E")" || pp_rc=$?
if [ "$pp_rc" -eq 0 ] && [ "$pp_out" = foundation ]; then ok
else bad PP15-exported-empty-shadows-file "rc=$pp_rc profile='$pp_out' want='foundation'"; fi

# PP16: the old FND_PROFILE key is not read — a project file that still carries it leaves the
# answer to detection, in the process env and in both file layers
mkdir -p "$PPR/legacy/.claude" "$PPR/legacy/snippets"; : > "$PPR/legacy/snippets/@card.liquid"
printf 'FND_PROFILE=none\n' > "$PPR/legacy/.claude/domaine.env"
PPG3="$PPR/xdg3"; mkdir -p "$PPG3/domaine"; printf 'FND_PROFILE=theme\n' > "$PPG3/domaine/env"
pp_rc=0
pp_out="$(FND_PROFILE=none XDG_CONFIG_HOME="$PPG3" "$BASH_BIN" "$PPS" "$PPR/legacy" 2>"$E")" || pp_rc=$?
if [ "$pp_rc" -eq 0 ] && [ "$pp_out" = foundation ] && [ ! -s "$E" ]; then ok
else bad PP16-legacy-key-ignored "rc=$pp_rc profile='$pp_out' err=$(head -c 120 "$E" | tr '\n' ' ')"; fi

# PP17: `--help` / `-h` print the header block and exit 0 (fe's doctor runs every script's --help)
for ha in --help -h; do
  pp_run "$ha"
  if [ "$pp_rc" -eq 0 ] && printf '%s\n' "$pp_out" | head -1 | grep -q '^project-profile.sh — ' \
     && printf '%s\n' "$pp_out" | grep -q '^  switch  FE_PROFILE forces the answer'; then ok
  else bad "PP17-help[$ha]" "rc=$pp_rc out=$(printf '%s' "$pp_out" | head -c 160 | tr '\n' ';')"; fi
done

# ═══ WT — worktree-theme.sh: the Shopify half of a worktree base made ═════════════════════════
# Scratch repos only: a main checkout with one commit, a linked worktree beside it, and the copy of
# the main checkout's shopify.theme.toml that base's worktree-setup.sh would have put there.
WTR="$TMP/wt"; mkdir -p "$WTR/home"
wt_git() { HOME="$WTR/home" GIT_CONFIG_NOSYSTEM=1 git -c user.name=t -c user.email=t@example.com "$@"; }
wt_key() { grep "^$1=" "$O" | head -1 | cut -d= -f2- ; }
PINNED_TOML='[environments.development]\nstore = "acme-dev"\n# theme = "111"  # fe:superseded\ntheme = "777"\npassword = "shptka_wtfixture"\n'
mk_wt() { # <name> → $WTR/<name>/main + linked worktree $WTR/<name>/wt (physical paths)
  mkdir -p "$WTR/$1"
  wt_git init -q "$WTR/$1/main"
  wt_git -C "$WTR/$1/main" commit -q --allow-empty -m init
  wt_git -C "$WTR/$1/main" worktree add -q "$WTR/$1/wt" -b "feat/$1" 2>/dev/null
}
wt_run() { rc=0; ( cd "${WT_CWD:-$TMP}" && HOME="$WTR/home" "$BASH_BIN" "$WTT" "$@" ) >"$O" 2>"$E" || rc=$?; }
wt_phys() { (cd "$1" && pwd -P); }

# WT1 (drift guard): `--help` / `-h` print the header's own `# Usage:` block, rc 0, anywhere in the args
WTH="$TMP/wt-usage-header"
awk '/^# Usage:/ { f = 1 } f { if ($0 == "#" || $0 !~ /^#( |$)/) exit; sub(/^# ?/, ""); print }' "$WTT" > "$WTH"
for ha in --help -h; do
  wt_run /nonexistent "$ha"
  if [ "$rc" -eq 0 ] && [ ! -s "$E" ] && [ "$(head -1 "$O")" = "Usage:" ] \
     && [ "$(wc -l < "$WTH" | tr -d ' ')" -ge 4 ] && diff -q "$O" "$WTH" >/dev/null; then ok
  else bad "WT1-help[$ha]" "rc=$rc diff=$(diff "$O" "$WTH" | head -c 300 | tr '\n' ';')"; fi
done

# WT2: usage errors are exit 2 with an `error=usage:` line on stdout
wt_usage_ok=1
for wt_case in none badport noport flag twodirs; do
  case "$wt_case" in
    none) set -- ;; badport) set -- "$TMP" --port 92a ;; noport) set -- "$TMP" --port ;;
    flag) set -- "$TMP" --force ;; twodirs) set -- "$TMP" "$TMP" ;;
  esac
  wt_run "$@"
  [ "$rc" -eq 2 ] && grep -q '^error=usage: ' "$O" || { wt_usage_ok=0; printf '%s rc=%s\n' "$wt_case" "$rc" >> "$TMP/wt2.log"; }
done
if [ "$wt_usage_ok" -eq 1 ]; then ok; else bad WT2-usage "$(tr '\n' ';' < "$TMP/wt2.log")"; fi

# WT3: a path that is not a directory, and a directory outside any git checkout, are errors (exit 1)
wt_run "$TMP/no-such-dir"
if [ "$rc" -eq 1 ] && grep -q "^error=no_such_dir dir=$TMP/no-such-dir$" "$O"; then ok
else bad WT3-no-such-dir "rc=$rc out=$(tr '\n' ';' < "$O")"; fi
mkdir -p "$WTR/plain"
wt_run "$WTR/plain"
if [ "$rc" -eq 1 ] && grep -q '^error=not_a_git_checkout ' "$O"; then ok
else bad WT3b-not-a-checkout "rc=$rc out=$(tr '\n' ';' < "$O")"; fi

# WT4: the MAIN checkout is refused and its pinned config stays byte-identical — un-pinning there
# would undo that checkout's own session theme
mk_wt a
printf "$PINNED_TOML" > "$WTR/a/main/shopify.theme.toml"
wt_before="$(fhash "$WTR/a/main/shopify.theme.toml")"
wt_run "$WTR/a/main"
if [ "$rc" -eq 1 ] && grep -q '^error=not_a_linked_worktree ' "$O" \
   && [ "$(fhash "$WTR/a/main/shopify.theme.toml")" = "$wt_before" ]; then ok
else bad WT4-main-checkout-refused "rc=$rc out=$(tr '\n' ';' < "$O")"; fi

# WT5: the inherited pin is undone in the worktree's copy — the shared dev theme is back, the
# session id is commented, the token line is untouched and never printed, and the stamp lands in the
# worktree's own git dir
cp "$WTR/a/main/shopify.theme.toml" "$WTR/a/wt/shopify.theme.toml"
wt_run "$WTR/a/wt"
WT_A="$(wt_phys "$WTR/a/wt")"
WT_A_GD="$(git -C "$WTR/a/wt" rev-parse --absolute-git-dir)"
if [ "$rc" -eq 0 ] && [ "$(wt_key worktree)" = "$WT_A" ] && [ "$(wt_key toml)" = present ] \
   && [ "$(wt_key toml_unpinned)" = yes ] && grep -q '^theme = "111"$' "$WTR/a/wt/shopify.theme.toml" \
   && grep -q '^# theme = "777"$' "$WTR/a/wt/shopify.theme.toml" \
   && grep -q '^password = "shptka_wtfixture"$' "$WTR/a/wt/shopify.theme.toml" \
   && ! grep -q 'shptka_' "$O" "$E" && [ -f "$WT_A_GD/fe-worktree-theme" ] \
   && [ "$(fhash "$WTR/a/main/shopify.theme.toml")" = "$wt_before" ]; then ok
else bad WT5-inherited-pin-undone "rc=$rc out=$(tr '\n' ';' < "$O") file=$(grep -v password "$WTR/a/wt/shopify.theme.toml" | tr '\n' ';')"; fi

# WT6: idempotent — a later run reports `already` and leaves a pin the worktree has since made for
# itself exactly as it is
printf "$PINNED_TOML" | sed 's/777/555/' > "$WTR/a/wt/shopify.theme.toml"
wt_before="$(fhash "$WTR/a/wt/shopify.theme.toml")"
wt_run "$WTR/a/wt"
if [ "$rc" -eq 0 ] && [ "$(wt_key toml_unpinned)" = already ] \
   && [ "$(fhash "$WTR/a/wt/shopify.theme.toml")" = "$wt_before" ]; then ok
else bad WT6-rerun-keeps-own-pin "rc=$rc out=$(tr '\n' ';' < "$O")"; fi

# WT7: a copy that carried no pin is `no`, unchanged, and stamped all the same
mk_wt b
printf '[environments.development]\nstore = "acme-dev"\ntheme = "111"\n' > "$WTR/b/wt/shopify.theme.toml"
wt_before="$(fhash "$WTR/b/wt/shopify.theme.toml")"
wt_run "$WTR/b/wt"
if [ "$rc" -eq 0 ] && [ "$(wt_key toml_unpinned)" = no ] \
   && [ "$(fhash "$WTR/b/wt/shopify.theme.toml")" = "$wt_before" ] \
   && [ -f "$(git -C "$WTR/b/wt" rev-parse --absolute-git-dir)/fe-worktree-theme" ]; then ok
else bad WT7-unpinned-copy "rc=$rc out=$(tr '\n' ';' < "$O")"; fi

# WT8: no config yet → `toml=missing` + a warn, rc 0 and NO stamp, so the copy that arrives later
# is still un-pinned by the next run
mk_wt c
wt_run "$WTR/c/wt"
WT_C_GD="$(git -C "$WTR/c/wt" rev-parse --absolute-git-dir)"
if [ "$rc" -eq 0 ] && [ "$(wt_key toml)" = missing ] && grep -q '^warn=no_shopify_theme_toml ' "$O" \
   && [ ! -f "$WT_C_GD/fe-worktree-theme" ]; then ok
else bad WT8-toml-missing "rc=$rc out=$(tr '\n' ';' < "$O")"; fi
printf "$PINNED_TOML" > "$WTR/c/wt/shopify.theme.toml"
wt_run "$WTR/c/wt"
if [ "$rc" -eq 0 ] && [ "$(wt_key toml_unpinned)" = yes ] && grep -q '^theme = "111"$' "$WTR/c/wt/shopify.theme.toml"; then ok
else bad WT8b-late-copy-unpinned "rc=$rc out=$(tr '\n' ';' < "$O")"; fi

# WT9: a pin that cannot be rewritten (read-only copy) is `failed` + warn, rc 0, file as it came and
# no stamp — the next run, once the file is writable, still un-pins
mk_wt d
printf "$PINNED_TOML" > "$WTR/d/wt/shopify.theme.toml"; chmod 444 "$WTR/d/wt/shopify.theme.toml"
wt_before="$(fhash "$WTR/d/wt/shopify.theme.toml")"
wt_run "$WTR/d/wt"
chmod 644 "$WTR/d/wt/shopify.theme.toml"
if [ "$rc" -eq 0 ] && [ "$(wt_key toml_unpinned)" = failed ] && grep -q '^warn=toml_unpin_failed ' "$O" \
   && [ "$(fhash "$WTR/d/wt/shopify.theme.toml")" = "$wt_before" ] \
   && [ ! -f "$(git -C "$WTR/d/wt" rev-parse --absolute-git-dir)/fe-worktree-theme" ]; then ok
else bad WT9-unpin-failed "rc=$rc out=$(tr '\n' ';' < "$O")"; fi
wt_run "$WTR/d/wt"
if [ "$rc" -eq 0 ] && [ "$(wt_key toml_unpinned)" = yes ]; then ok
else bad WT9b-retry-after-failure "rc=$rc out=$(tr '\n' ';' < "$O")"; fi

# WT10: a pin the fnd plugin wrote into the source checkout is undone the same way
mk_wt e
printf "$PINNED_TOML" | sed 's/fe:superseded/fnd:superseded/' > "$WTR/e/wt/shopify.theme.toml"
wt_run "$WTR/e/wt"
if [ "$rc" -eq 0 ] && [ "$(wt_key toml_unpinned)" = yes ] && grep -q '^theme = "111"$' "$WTR/e/wt/shopify.theme.toml" \
   && ! grep -q 'superseded' "$WTR/e/wt/shopify.theme.toml"; then ok
else bad WT10-legacy-pin-undone "rc=$rc out=$(tr '\n' ';' < "$O")"; fi

# WT11: the dev-server line follows the worktree's profile — Foundation's npm wrapper on a
# Foundation checkout, the CLI everywhere else — and never appears without --theme
mkdir -p "$WTR/b/wt/snippets"; : > "$WTR/b/wt/snippets/@card.liquid"
wt_run "$WTR/b/wt" --port 9301
if [ "$rc" -eq 0 ] && [ "$(wt_key profile)" = foundation ] \
   && grep -qx '  # dev server:  npm run dev -- --theme <session-theme-id> --port 9301' "$O"; then ok
else bad WT11-foundation-line "rc=$rc out=$(tr '\n' ';' < "$O")"; fi
mkdir -p "$WTR/c/wt/layout"; : > "$WTR/c/wt/layout/theme.liquid"
wt_run "$WTR/c/wt" --port 9302
if [ "$rc" -eq 0 ] && [ "$(wt_key profile)" = theme ] \
   && grep -qx '  # dev server:  shopify theme dev --theme <session-theme-id> --port 9302' "$O"; then ok
else bad WT11b-theme-line "rc=$rc out=$(tr '\n' ';' < "$O")"; fi
rc=0; ( cd "$TMP" && HOME="$WTR/home" FE_PROFILE=theme "$BASH_BIN" "$WTT" "$WTR/b/wt" ) >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ "$(wt_key profile)" = theme ] && grep -q 'shopify theme dev --theme <session-theme-id>' "$O"; then ok
else bad WT11c-fe-profile-override "rc=$rc out=$(tr '\n' ';' < "$O")"; fi
if ! grep -E 'dev server:' "$O" | grep -qv -- '--theme <session-theme-id>'; then ok
else bad WT11d-never-without-theme "$(grep 'dev server:' "$O")"; fi

# WT12: the port comes from the dev-port base's worktree-setup.sh recorded for THIS worktree in
# the shared workspace notes; another worktree's line is not this one's; --port wins; nothing
# recorded → `dev_port=unknown` and a placeholder in the line
mkdir -p "$WTR/a/main/.claude/tasks/A-1" "$WTR/a/wt/.claude"
ln -s "$(wt_phys "$WTR/a/main")/.claude/tasks" "$WTR/a/wt/.claude/tasks"
printf -- '- 2026-10-01 worktree `%s-other` on branch `feat/o`, dev-port: 9299\n- 2026-10-02 worktree `%s` on branch `feat/a`, dev-port: 9294\n' \
  "$WT_A" "$WT_A" > "$WTR/a/main/.claude/tasks/A-1/notes.md"
wt_run "$WTR/a/wt"
if [ "$rc" -eq 0 ] && [ "$(wt_key dev_port)" = 9294 ] && grep -q -- '--port 9294$' "$O"; then ok
else bad WT12-port-from-notes "rc=$rc out=$(tr '\n' ';' < "$O")"; fi
wt_run "$WTR/a/wt" --port 9310
if [ "$rc" -eq 0 ] && [ "$(wt_key dev_port)" = 9310 ]; then ok
else bad WT12b-port-flag-wins "rc=$rc out=$(tr '\n' ';' < "$O")"; fi
wt_run "$WTR/e/wt"
if [ "$rc" -eq 0 ] && [ "$(wt_key dev_port)" = unknown ] && grep -q -- '--port <dev-port>$' "$O"; then ok
else bad WT12c-port-unknown "rc=$rc out=$(tr '\n' ';' < "$O")"; fi

# WT13: run from inside the worktree on a subdirectory (`.` from its own session) it answers about
# the worktree's toplevel
mkdir -p "$WTR/a/wt/sections"
WT_CWD="$WTR/a/wt/sections" wt_run .
if [ "$rc" -eq 0 ] && [ "$(wt_key worktree)" = "$WT_A" ] && [ "$(wt_key toml_unpinned)" = already ]; then ok
else bad WT13-subdir-resolves-toplevel "rc=$rc out=$(tr '\n' ';' < "$O")"; fi

# WT14: installed without its session-theme.sh sibling it refuses before touching the config
LONE_T="$TMP/lonewtt"; mkdir -p "$LONE_T"; cp "$WTT" "$LONE_T/worktree-theme.sh"
mk_wt f
printf "$PINNED_TOML" > "$WTR/f/wt/shopify.theme.toml"; wt_before="$(fhash "$WTR/f/wt/shopify.theme.toml")"
rc=0; ( cd "$TMP" && HOME="$WTR/home" "$BASH_BIN" "$LONE_T/worktree-theme.sh" "$WTR/f/wt" ) >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 1 ] && grep -q "^error=session_lib_not_found path=$LONE_T/session-theme.sh$" "$O" \
   && [ "$(fhash "$WTR/f/wt/shopify.theme.toml")" = "$wt_before" ]; then ok
else bad WT14-session-lib-missing "rc=$rc out=$(tr '\n' ';' < "$O")"; fi

echo "fe-scripts-sim: $pass passed, $fail failed"
if [ "$fail" -gt 0 ]; then printf '%s' "$failures"; exit 1; fi
